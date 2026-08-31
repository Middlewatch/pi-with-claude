#!/usr/bin/env node
// The extension's gate smoke, token-free end to end.
//
// Two tiers in one file:
//   - REAL-PI phases: spawn the installed `pi -p` with the extension
//     loaded and the Agent SDK pointed at tests/fake_claude.py, then
//     assert on Pi's output, the extension's debug trace, and the
//     fake's stdin log (the wire witness).
//   - STUB-API phases (child processes of this file, one per scenario
//     for fresh module state): drive streamSimple directly under a
//     stubbed Pi API to reach histories real `pi -p` cannot produce —
//     seeded resumes, stale tool results, regression fixtures.
//
// Ported from claude-go's tests/pi_smoke.mjs; the stub-API scenarios
// carry over, the real-pi tier is new with the SDK rebuild.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = fileURLToPath(import.meta.url);
const root = dirname(dirname(here));
const phase = process.argv[2];

function fail(msg) {
  console.error(`pi_smoke: FAIL — ${msg}`);
  process.exit(1);
}

// The context occupancy fake_claude.py answers get_context_usage with.
// The fixtures' per-turn counters are deliberately NOT this number (the
// default fixture reports 879 input over one request, the tool fixture
// 1998+ over two), so an extension that relayed them would fail here.
// Pi decides occupancy from two places in one usage object — compaction
// thresholds on totalTokens, pi-ai's silent-overflow on input+cacheRead
// vs contextWindow — and a disagreement is a live failure.
const FAKE_CONTEXT_TOKENS = 869;

function checkOccupancy(msg, where) {
  const u = msg.usage ?? {};
  if (u.totalTokens !== FAKE_CONTEXT_TOKENS)
    fail(`${where}: usage.totalTokens ${u.totalTokens}, want the CLI's own ${FAKE_CONTEXT_TOKENS}`);
  if (u.input + u.cacheRead !== FAKE_CONTEXT_TOKENS)
    fail(
      `${where}: usage.input+cacheRead ${u.input}+${u.cacheRead}, want ${FAKE_CONTEXT_TOKENS} — ` +
        "Pi reads this sum as occupancy",
    );
  if (!(u.cost?.total > 0)) fail(`${where}: cost.total ${u.cost?.total} — the CLI's estimate was dropped (I7)`);
}

// ---------------------------------------------------------------------
// Stub-API phases (run as child processes; fresh module state each).

async function loadProvider() {
  const { default: register } = await import(new URL("../src/index.ts", import.meta.url));
  let captured = null;
  register({
    registerProvider(id, config) {
      captured = { id, config };
    },
    registerCommand() {},
  });
  if (!captured) fail("extension did not call registerProvider");
  return captured;
}

async function turnOf(cfg, model, ctx, options) {
  const s = cfg.streamSimple(model, ctx, options);
  for await (const _ of s) { /* drain */ }
  return await s.result();
}

if (phase === "--seeded") {
  // Resumed-session scenario: fresh extension state, a context that
  // already carries assistant history. The extension must fresh-start
  // once — never restart per turn — and remember what it dropped.
  const { id, config: cfg } = await loadProvider();
  const model = { id: cfg.models[0].id, api: "pi-with-claude", provider: id };
  const seeded = {
    systemPrompt: "You are a test.",
    messages: [
      { role: "user", content: "an earlier question", timestamp: Date.now() - 60000 },
      {
        role: "assistant",
        content: [{ type: "text", text: "an earlier answer" }],
        api: "pi-with-claude", provider: "pi-with-claude", model: model.id,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop", timestamp: Date.now() - 50000,
      },
      { role: "user", content: "a fresh question", timestamp: Date.now() },
    ],
  };
  const m1 = await turnOf(cfg, model, seeded);
  if (m1.stopReason !== "stop") fail(`seeded turn 1 stopReason ${m1.stopReason}: ${m1.errorMessage ?? ""}`);
  checkOccupancy(m1, "seeded turn 1");
  seeded.messages.push(m1, { role: "user", content: "and one more", timestamp: Date.now() });
  const m2 = await turnOf(cfg, model, seeded);
  if (m2.stopReason !== "stop") fail(`seeded turn 2 stopReason ${m2.stopReason}: ${m2.errorMessage ?? ""}`);
  console.log("pi_smoke seeded: OK");
  process.exit(0);
}

if (phase === "--stale") {
  // A tool_result answering a call whose turn already ended is stale:
  // the honest restart runs, the trailing user text still goes out.
  const { id, config: cfg } = await loadProvider();
  const model = { id: cfg.models[0].id, api: "pi-with-claude", provider: id };
  const ctx = { systemPrompt: "You are a test.", messages: [{ role: "user", content: "one", timestamp: Date.now() }] };
  const m1 = await turnOf(cfg, model, ctx);
  if (m1.stopReason !== "stop") fail(`stale turn 1 stopReason ${m1.stopReason}: ${m1.errorMessage ?? ""}`);
  ctx.messages.push(
    m1,
    { role: "toolResult", toolCallId: "toolu_never_issued", toolName: "add",
      content: [{ type: "text", text: "5" }], isError: false, timestamp: Date.now() },
    { role: "user", content: "two", timestamp: Date.now() },
  );
  const m2 = await turnOf(cfg, model, ctx);
  if (m2.stopReason !== "stop") fail(`stale turn 2 stopReason ${m2.stopReason}: ${m2.errorMessage ?? ""}`);
  console.log("pi_smoke stale: OK");
  process.exit(0);
}

// Shared by --deny / --empty-thinking / --thinkless: one tool loop with
// the pause surfaced to the (stub) host and the completion resolving it.
async function toolLoop({ isError, wantThinking }) {
  const { id, config: cfg } = await loadProvider();
  const model = { id: cfg.models[0].id, api: "pi-with-claude", provider: id };
  const ctx = {
    systemPrompt: "You are a test.",
    tools: [{ name: "add", description: "adds numbers", parameters: { type: "object" } }],
    messages: [{ role: "user", content: "add 2 and 3", timestamp: Date.now() }],
  };
  const pause = await turnOf(cfg, model, ctx);
  if (pause.stopReason !== "toolUse") fail(`tool pause stopReason ${pause.stopReason}: ${pause.errorMessage ?? ""}`);
  const call = pause.content.find((c) => c.type === "toolCall");
  if (!call) fail("no toolCall block in the paused message");
  if (call.name.startsWith("mcp__")) fail(`toolCall surfaced under wire name ${call.name} — Pi cannot execute it`);
  const think = pause.content.find((c) => c.type === "thinking");
  if (wantThinking !== undefined) {
    if (!think) fail("fixture did not produce a thinking block");
    if (wantThinking === "") {
      if (think.thinking !== "") fail(`expected an empty thinking block, got ${JSON.stringify(think.thinking.slice(0, 60))}`);
    } else if (!think.thinking.startsWith(wantThinking)) {
      fail(`recovered thinking is not the streamed text: ${JSON.stringify(think.thinking.slice(0, 80))}`);
    }
  }
  ctx.messages.push(pause, {
    role: "toolResult", toolCallId: call.id, toolName: call.name,
    content: [{ type: "text", text: isError ? "denied by host policy" : "5" }],
    isError, timestamp: Date.now(),
  });
  const done = await turnOf(cfg, model, ctx);
  if (done.stopReason !== "stop") fail(`resumed turn stopReason ${done.stopReason}: ${done.errorMessage ?? ""}`);
  // The tool fixture's result sums two requests; the occupancy Pi sees
  // must still be the CLI's own answer.
  checkOccupancy(done, "resumed tool turn");
  return call;
}

if (phase === "--deny") {
  // Deny-as-data: an is_error completion resolves the parked handler
  // and the turn continues to a normal stop — never a session error.
  const call = await toolLoop({ isError: true });
  console.log(`pi_smoke deny: OK — plain name ${JSON.stringify(call.name)}, denial flowed as data`);
  process.exit(0);
}

if (phase === "--empty-thinking") {
  // The fixture's final frames report the thinking block with no text,
  // but the deltas carried it: the streamed reasoning must reach the
  // host. Regression from claude-go (2026-08-10, opus at high).
  await toolLoop({ isError: false, wantThinking: "The user wants me to use the add tool" });
  console.log("pi_smoke empty-thinking: OK");
  process.exit(0);
}

if (phase === "--thinkless") {
  // No deltas ever carried the thinking text: nothing to recover, the
  // block stays honestly empty, and the mirror still matches across
  // the tool loop.
  await toolLoop({ isError: false, wantThinking: "" });
  console.log("pi_smoke thinkless: OK");
  process.exit(0);
}

if (phase === "--interrupt") {
  // FAKE_CLAUDE_HOLD_AFTER parks the fake mid-stream until the
  // interrupt control request arrives; the turn must come back as Pi's
  // aborted stop with the streamed partial content intact.
  const { id, config: cfg } = await loadProvider();
  const model = { id: cfg.models[0].id, api: "pi-with-claude", provider: id };
  const controller = new AbortController();
  const stream = cfg.streamSimple(
    model,
    { systemPrompt: "You are a test.", messages: [{ role: "user", content: "count forever", timestamp: Date.now() }] },
    { signal: controller.signal },
  );
  for await (const ev of stream) {
    if (ev.type === "thinking_delta" || ev.type === "text_delta") controller.abort();
  }
  const m = await stream.result();
  if (m.stopReason !== "aborted") fail(`interrupted turn stopReason ${m.stopReason}: ${m.errorMessage ?? ""}`);
  if (!m.content.length) fail("interrupted turn lost its streamed partial content");
  console.log("pi_smoke interrupt: OK");
  process.exit(0);
}

if (phase === "--steering") {
  // Steering typed while tools run: alone it is refused with the
  // holding message; alongside completions it is withheld from the
  // resumed flight and delivered on the next ordinary turn.
  const { id, config: cfg } = await loadProvider();
  const model = { id: cfg.models[0].id, api: "pi-with-claude", provider: id };
  const ctx = {
    systemPrompt: "You are a test.",
    tools: [{ name: "add", description: "adds numbers", parameters: { type: "object" } }],
    messages: [{ role: "user", content: "add 2 and 3", timestamp: Date.now() }],
  };
  const pause = await turnOf(cfg, model, ctx);
  if (pause.stopReason !== "toolUse") fail(`steering pause stopReason ${pause.stopReason}: ${pause.errorMessage ?? ""}`);
  const call = pause.content.find((c) => c.type === "toolCall");

  ctx.messages.push(pause, { role: "user", content: "actually, wait", timestamp: Date.now() });
  const refused = await turnOf(cfg, model, ctx);
  if (refused.stopReason !== "error") fail(`steering-only turn stopReason ${refused.stopReason}, want error`);
  if (!(refused.errorMessage ?? "").includes("only its results")) {
    fail(`steering-only refusal does not explain itself: ${refused.errorMessage}`);
  }

  ctx.messages.push({
    role: "toolResult", toolCallId: call.id, toolName: call.name,
    content: [{ type: "text", text: "5" }], isError: false, timestamp: Date.now(),
  });
  const done = await turnOf(cfg, model, ctx);
  if (done.stopReason !== "stop") fail(`resumed turn stopReason ${done.stopReason}: ${done.errorMessage ?? ""}`);

  ctx.messages.push(done);
  // The withheld text goes out on its own turn now. (The fake replays
  // the tool fixture per user frame, so this delivery turn pauses on a
  // fresh tool call — toolUse IS the proof the text was sent.)
  const delivered = await turnOf(cfg, model, ctx);
  if (delivered.stopReason !== "toolUse") fail(`steering delivery turn stopReason ${delivered.stopReason}: ${delivered.errorMessage ?? ""}`);
  console.log("pi_smoke steering: OK");
  process.exit(0);
}

if (phase !== undefined) fail(`unknown phase ${phase}`);

// ---------------------------------------------------------------------
// Parent: real-pi phases, then the stub-API children.

function piTurn(message, { env = {}, extraArgs = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pwc-smoke-"));
  const tracePath = join(dir, "trace.log");
  const wirePath = join(dir, "fake.log");
  const args = [
    "-p",
    "--provider", "pi-with-claude",
    "--model", "haiku",
    "-e", join(root, "src", "index.ts"),
    "-ne", "-ns", "-np", "-nc", "--no-themes", "--no-session",
    ...extraArgs,
    message,
  ];
  const r = spawnSync("pi", args, {
    encoding: "utf-8",
    timeout: 120000,
    env: {
      ...process.env,
      PI_OFFLINE: "1",
      PI_WITH_CLAUDE_CLAUDE: join(root, "tests", "fake_claude.py"),
      PI_WITH_CLAUDE_DEBUG: tracePath,
      FAKE_CLAUDE_LOG: wirePath,
      ...env,
    },
  });
  let trace = "";
  let wire = [];
  try {
    trace = readFileSync(tracePath, "utf-8");
  } catch {}
  try {
    wire = readFileSync(wirePath, "utf-8")
      .split("\n")
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
  } catch {}
  rmSync(dir, { recursive: true, force: true });
  return { r, trace, wire };
}

function runStubPhase(flag, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pwc-phase-"));
  const tracePath = join(dir, "trace.log");
  const child = spawnSync(process.execPath, [here, flag], {
    encoding: "utf-8",
    timeout: 120000,
    env: {
      ...process.env,
      PI_WITH_CLAUDE_CLAUDE: join(root, "tests", "fake_claude.py"),
      PI_WITH_CLAUDE_DEBUG: tracePath,
      ...env,
    },
  });
  let trace = "";
  try {
    trace = readFileSync(tracePath, "utf-8");
  } catch {}
  rmSync(dir, { recursive: true, force: true });
  if (child.status !== 0) {
    fail(`${flag} phase exited ${child.status}: ${child.stderr?.slice(0, 500)} ${child.stdout?.slice(0, 300)}`);
  }
  return trace;
}

const count = (text, pattern) => (text.match(pattern) ?? []).length;

// --- Real pi, one text turn: open, deltas, stop. -nt keeps Pi's
// builtin tools out so this is the pure Pipe profile (tools []).
{
  const { r, trace, wire } = piTurn("hello from pi", { extraArgs: ["-nt"] });
  if (r.status !== 0) fail(`pi exited ${r.status}: ${r.stderr?.slice(0, 600)} ${r.stdout?.slice(0, 400)}`);
  // The fixture's text block is "ok" (fixtures/turn-deltas.jsonl).
  if (!r.stdout.includes("ok")) fail(`fixture reply not in pi output: ${r.stdout.slice(0, 400)}`);

  // The Pipe profile reached the spawned CLI: model alias, stripped
  // tool set, no settings tree.
  const argv = wire.find((o) => o.fake_argv)?.fake_argv;
  if (!argv) fail("fake claude logged no argv — was it spawned at all?");
  const modelIdx = argv.indexOf("--model");
  if (modelIdx < 0 || argv[modelIdx + 1] !== "haiku") fail(`--model haiku not in fake argv: ${argv.join(" ")}`);
  const toolsIdx = argv.indexOf("--tools");
  if (toolsIdx < 0 || argv[toolsIdx + 1] !== "") fail(`stripped --tools '' not in fake argv: ${argv.join(" ")}`);
  if (!argv.some((a) => a.startsWith("--setting-sources="))) fail(`--setting-sources= not in fake argv: ${argv.join(" ")}`);

  // The initialize handshake carried Pi's system prompt (string,
  // wrapped by the SDK into a one-element array) — never a preset.
  const init = wire.find((o) => o.type === "control_request" && o.request?.subtype === "initialize");
  if (!init) fail("no initialize control request reached the fake");
  const sp = init.request.systemPrompt;
  if (!Array.isArray(sp) || sp.length !== 1 || typeof sp[0] !== "string" || sp[0].length === 0) {
    fail(`initialize.systemPrompt is not Pi's prompt as a one-string array: ${JSON.stringify(sp)?.slice(0, 200)}`);
  }

  const deltas = count(trace, /frame: stream_event content_block_delta/g);
  if (deltas < 3) fail(`only ${deltas} content_block_delta frames in trace — streaming path broken`);
  if (!/frame: result success/.test(trace)) fail(`no successful result frame in trace:\n${trace.slice(0, 800)}`);
  if (count(trace, /turn sent:/g) !== 1) fail("expected exactly one turn sent");
  if (!trace.includes(`occupancy: ${FAKE_CONTEXT_TOKENS} (cli)`)) {
    fail(`occupancy through real pi is not the CLI's own answer:\n${trace.slice(-400)}`);
  }
  console.log("pi_smoke text: OK — one text turn through real pi");
}

// --- Real pi, tool inversion end to end: the scripted model calls the
// proxy, the extension pauses, Pi executes its own registered tool, and
// the completion resumes the same CLI turn.
{
  // -t add: exactly one registered tool, so the fixture's tools/list
  // handshake and the model's tool_use both land on it.
  const { r, trace, wire } = piTurn("add 2 and 3", {
    extraArgs: ["-e", join(root, "tests", "tool_ext.ts"), "-t", "add"],
  });
  if (r.status !== 0) fail(`tool pi exited ${r.status}: ${r.stderr?.slice(0, 600)} ${r.stdout?.slice(0, 400)}`);
  if (!r.stdout.includes("5")) fail(`final tool answer not in pi output: ${r.stdout.slice(0, 400)}`);
  const init = wire.find((o) => o.type === "control_request" && o.request?.subtype === "initialize");
  if (!init || JSON.stringify(init.request.sdkMcpServers) !== '["pi"]') {
    fail(`initialize did not declare the in-process server: ${JSON.stringify(init?.request?.sdkMcpServers)}`);
  }
  if (count(trace, /tool pause: 1 call\(s\) parked/g) !== 1) fail(`no single tool pause in trace:\n${trace.slice(-800)}`);
  if (count(trace, /resumed 1 tool call\(s\)/g) !== 1) fail(`no single tool resume in trace:\n${trace.slice(-800)}`);
  if (count(trace, /reopening session/g) !== 0) fail("tool loop reopened the session — pause/resume regression");
  console.log("pi_smoke tools: OK — inversion loop through real pi");
}

// --- Stub-API children.
{
  const trace = runStubPhase("--seeded");
  if (count(trace, /fresh start:/g) !== 1) fail(`seeded phase fresh-started ${count(trace, /fresh start:/g)} time(s), want exactly 1`);
  if (count(trace, /turn sent:/g) !== 2) fail(`seeded phase sent ${count(trace, /turn sent:/g)} turn(s), want 2`);
  if (count(trace, /reopening session/g) !== 0) fail("seeded phase reopened — resume regression");
}
{
  const trace = runStubPhase("--stale");
  if (count(trace, /stale tool_result between turns: reopening session/g) !== 1) {
    fail(`stale phase did not take the stale-restart path:\n${trace.slice(-800)}`);
  }
  if (count(trace, /fresh start:/g) !== 1) fail("stale phase must fresh-start exactly once");
}
{
  const trace = runStubPhase("--deny");
  if (count(trace, /tool pause: 1 call\(s\) parked/g) !== 1) fail("deny phase saw no tool pause");
  if (count(trace, /resumed 1 tool call\(s\)/g) !== 1) fail("deny phase saw no resume");
  if (count(trace, /reopening session/g) !== 0) fail("deny phase reopened — deny must flow as data");
}
for (const [flag, fixture] of [
  ["--empty-thinking", "tool-call-turn-empty-thinking.jsonl"],
  ["--thinkless", "tool-call-turn-thinkless.jsonl"],
]) {
  const trace = runStubPhase(flag, { FAKE_CLAUDE_FIXTURE: join(root, "fixtures", fixture) });
  for (const [pattern, label] of [[/fresh start:/g, "fresh start"], [/reopening session/g, "reopen"]]) {
    if (count(trace, pattern) !== 0) fail(`${flag} took a ${label} — the mirror mismatched across the tool loop`);
  }
}
{
  // Park after 8 replayed frames: init, status, message_start, block
  // start, and two thinking deltas are through, so the abort lands
  // mid-stream with partial content to preserve.
  const trace = runStubPhase("--interrupt", { FAKE_CLAUDE_HOLD_AFTER: "8" });
  if (count(trace, /interrupt requested/g) !== 1) fail("interrupt phase never requested the interrupt");
  if (!/frame: result error_during_execution/.test(trace)) fail("interrupt phase saw no error_during_execution result");
  if (count(trace, /reopening session/g) !== 0) fail("interrupt phase reopened — an interrupt must not cost the session");
}
{
  const trace = runStubPhase("--steering");
  // Two withholds: the steering-only refusal filters it first, then
  // the completion turn withholds it from the resumed flight.
  if (count(trace, /withheld 1 steering message\(s\)/g) !== 2) {
    fail(`steering phase did not withhold the in-flight text twice:\n${trace.slice(-600)}`);
  }
  if (count(trace, /turn sent:/g) !== 2) fail("steering phase: want exactly 2 sent turns (opening + delivery)");
  if (count(trace, /turn resumed:/g) !== 1) fail("steering phase: want exactly 1 resumed turn");
  if (count(trace, /reopening session/g) !== 0) fail("steering phase reopened — withheld steering must not restart");
}

console.log("pi_smoke: OK — all phases green");
