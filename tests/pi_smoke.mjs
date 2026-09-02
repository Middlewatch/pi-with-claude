#!/usr/bin/env node
// The extension's gate smoke, token-free end to end.
//
// Two tiers in one file:
//   - REAL-PI phases: spawn the installed `pi -p` with the extension
//     loaded and the bridge pointed at tests/fake_claude.py, then
//     assert on Pi's output, the extension's debug trace, and the
//     fake's stdin log (the wire witness).
//   - STUB-API phases (child processes of this file, one per scenario
//     for fresh module state): drive streamSimple directly under a
//     stubbed Pi API to reach histories real `pi -p` cannot produce —
//     seeded resumes, stale tool results, regression fixtures.
//
// Ported from claude-go's tests/pi_smoke.mjs; the stub-API scenarios
// carry over, the real-pi tier arrived with the SDK rebuild and rides
// the native bridge unchanged — the same wire from a different client.

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
  const commands = new Map();
  register({
    registerProvider(id, config) {
      captured = { id, config };
    },
    on() {},
    registerCommand(name, config) {
      commands.set(name, config);
    },
  });
  if (!captured) fail("extension did not call registerProvider");
  captured.commands = commands;
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

// Shared by --deny / --empty-thinking / --thinkless / --double-thinking:
// one tool loop with the pause surfaced to the (stub) host and the
// completion resolving it. wantThinking checks the first thinking
// block's text ("" for empty, else a prefix); wantBlocks checks the
// whole run of thinking blocks the same way, in order.
async function toolLoop({ isError, wantThinking, wantBlocks }) {
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
  if (wantBlocks) {
    const got = pause.content.filter((c) => c.type === "thinking").map((c) => c.thinking);
    const ok = got.length === wantBlocks.length && got.every((t, i) => (wantBlocks[i] === "" ? t === "" : t.startsWith(wantBlocks[i])));
    if (!ok) fail(`thinking blocks ${JSON.stringify(got.map((t) => t.slice(0, 40)))}, want ${JSON.stringify(wantBlocks.map((t) => t.slice(0, 40)))}`);
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

if (phase === "--double-thinking") {
  // Two thinking blocks in one message — an empty signed block, then
  // the summary (fable 5.1 at high effort, characterized 2026-09-02):
  // the summary must reach the host once, not be copied into the
  // empty block as well.
  await toolLoop({ isError: false, wantBlocks: ["", "The user wants me to use the add tool"] });
  console.log("pi_smoke double-thinking: OK");
  process.exit(0);
}

if (phase === "--serial-dispatch") {
  // One message, three tool_use blocks. The CLI dispatches hosted calls
  // one at a time (tools/call k+1 only after result k) while the model
  // keeps streaming the later blocks, so blocks 2 and 3 are on the
  // stream before call 2 exists (claude 2.1.258, characterized
  // 2026-09-02 from two frozen sessions). Each stretch must hand Pi the
  // calls that have handlers and hold the rest; waiting for every
  // streamed block to park deadlocks — the CLI sends the next park only
  // after a result Pi cannot produce until the stretch ends.
  const { id, config: cfg } = await loadProvider();
  const model = { id: cfg.models[0].id, api: "pi-with-claude", provider: id };
  const ctx = {
    systemPrompt: "You are a test.",
    tools: [{ name: "add", description: "adds numbers", parameters: { type: "object" } }],
    messages: [{ role: "user", content: "add three pairs", timestamp: Date.now() }],
  };
  // A hung stretch is the failure under test: bound each one well
  // inside the parent's child timeout so red reads as red.
  const deadline = (p, what) =>
    Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} hung for 10 s`)), 10000))]);
  const seen = [];
  const stretches = [];
  let msg = await deadline(turnOf(cfg, model, ctx), "first stretch").catch((e) => fail(e.message));
  while (msg.stopReason === "toolUse") {
    const calls = msg.content.filter((c) => c.type === "toolCall");
    if (calls.length === 0) fail("toolUse stop with no toolCall block");
    stretches.push(calls.map((c) => c.id));
    if (stretches.length > 3) fail(`more stretches than calls: ${JSON.stringify(stretches)}`);
    ctx.messages.push(msg);
    for (const call of calls) {
      seen.push(call.id);
      ctx.messages.push({
        role: "toolResult", toolCallId: call.id, toolName: call.name,
        content: [{ type: "text", text: "5" }], isError: false, timestamp: Date.now(),
      });
    }
    msg = await deadline(turnOf(cfg, model, ctx), `stretch after ${seen.length} result(s)`).catch((e) => fail(e.message));
  }
  if (msg.stopReason !== "stop") fail(`final stretch stopReason ${msg.stopReason}: ${msg.errorMessage ?? ""}`);
  const want = ["toolu_serial_1", "toolu_serial_2", "toolu_serial_3"];
  if (seen.join() !== want.join()) fail(`calls reached the host as ${JSON.stringify(seen)}, want ${JSON.stringify(want)} once each in wire order`);
  // Under serial dispatch exactly one call has a handler per stretch;
  // a stretch carrying more would hand Pi a call nothing can answer.
  if (!stretches.every((s) => s.length === 1)) fail(`stretches ${JSON.stringify(stretches)}, want one dispatched call each`);
  checkOccupancy(msg, "serial-dispatch final stretch");
  console.log(`pi_smoke serial-dispatch: OK — ${seen.length} calls over ${stretches.length} stretches`);
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

if (phase === "--init-surface") {
  // I6 negative drill: a claude advertising a tool nobody requested
  // (fake_claude --advertise-extra-tool, via a wrapper since the
  // bridge owns the argv) must fail the turn, not stream on a lying
  // surface.
  const { writeFileSync, mkdtempSync: mkTmp, chmodSync } = await import("node:fs");
  const wrapDir = mkTmp(join(tmpdir(), "pwc-wrap-"));
  const wrapper = join(wrapDir, "claude-extra-tool");
  writeFileSync(wrapper, `#!/bin/sh\nexec python3 "${join(root, "tests", "fake_claude.py")}" --advertise-extra-tool "$@"\n`);
  chmodSync(wrapper, 0o755);
  process.env.PI_WITH_CLAUDE_CLAUDE = wrapper;
  const { id, config: cfg } = await loadProvider();
  const model = { id: cfg.models[0].id, api: "pi-with-claude", provider: id };
  const m = await turnOf(cfg, model, {
    systemPrompt: "You are a test.",
    messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
  });
  if (m.stopReason !== "error") fail(`lying init surface stopReason ${m.stopReason}, want error`);
  if (!(m.errorMessage ?? "").includes("I6")) fail(`error does not name the surface assertion: ${m.errorMessage}`);
  console.log("pi_smoke init-surface: OK");
  process.exit(0);
}

if (phase === "--drift") {
  // A mid-session tool-set change cannot converge on a pinned MCP
  // handshake: it must reopen, never stream on the stale surface.
  const { id, config: cfg } = await loadProvider();
  const model = { id: cfg.models[0].id, api: "pi-with-claude", provider: id };
  const ctx = {
    systemPrompt: "You are a test.",
    tools: [{ name: "add", description: "adds numbers", parameters: { type: "object" } }],
    messages: [{ role: "user", content: "one", timestamp: Date.now() }],
  };
  const m1 = await turnOf(cfg, model, ctx);
  if (m1.stopReason !== "stop") fail(`drift turn 1 stopReason ${m1.stopReason}: ${m1.errorMessage ?? ""}`);
  ctx.tools = [...ctx.tools, { name: "mul", description: "multiplies numbers", parameters: { type: "object" } }];
  ctx.messages.push(m1, { role: "user", content: "two", timestamp: Date.now() });
  const m2 = await turnOf(cfg, model, ctx);
  if (m2.stopReason !== "stop") fail(`drift turn 2 stopReason ${m2.stopReason}: ${m2.errorMessage ?? ""}`);
  console.log("pi_smoke drift: OK");
  process.exit(0);
}

if (phase === "--fold") {
  // A folding extension (context-fold) rewrites absorbed history IN
  // PLACE — a stale tool_result's content and a thinking block's text
  // become short digests — and the first fold can land while a tool
  // call is in flight. The stateful CLI keeps the originals as the
  // model's lived context and can never be reseeded, so the masked
  // copies must diff as already-seen history: the paused turn resumes
  // on the live session and nothing fresh-starts or reopens (ADR 0001;
  // regression for claude-go's 2026-08-22 mid-flight fold crash).
  const { id, config: cfg } = await loadProvider();
  const model = { id: cfg.models[0].id, api: "pi-with-claude", provider: id };
  const ctx = {
    systemPrompt: "You are a test.",
    tools: [{ name: "add", description: "adds numbers", parameters: { type: "object" } }],
    messages: [{ role: "user", content: "add 2 and 3", timestamp: Date.now() }],
  };
  const round = async (label) => {
    const pause = await turnOf(cfg, model, ctx);
    if (pause.stopReason !== "toolUse") fail(`fold ${label} pause stopReason ${pause.stopReason}: ${pause.errorMessage ?? ""}`);
    const call = pause.content.find((c) => c.type === "toolCall");
    return { pause, call };
  };
  const r1 = await round("round 1");
  ctx.messages.push(r1.pause, {
    role: "toolResult", toolCallId: r1.call.id, toolName: r1.call.name,
    content: [{ type: "text", text: "5" }], isError: false, timestamp: Date.now(),
  });
  const d1 = await turnOf(cfg, model, ctx);
  if (d1.stopReason !== "stop") fail(`fold round 1 resume stopReason ${d1.stopReason}: ${d1.errorMessage ?? ""}`);

  ctx.messages.push(d1, { role: "user", content: "add 4 and 1", timestamp: Date.now() });
  const r2 = await round("round 2");

  // The fold lands here, mid-flight: mask round 1's tool result and
  // every absorbed thinking text — exactly the two block kinds the fold
  // ladder masks, digests in place of content, structure untouched.
  const t1 = ctx.messages.findIndex((m) => m.role === "toolResult");
  ctx.messages[t1] = { ...ctx.messages[t1], content: [{ type: "text", text: "{#ab12 FOLDED} add tool result" }] };
  for (const m of [r1.pause, d1]) {
    for (const b of m.content) if (b.type === "thinking" && b.thinking) b.thinking = "{#ab13 FOLDED}";
  }
  ctx.messages.push(r2.pause, {
    role: "toolResult", toolCallId: r2.call.id, toolName: r2.call.name,
    content: [{ type: "text", text: "5" }], isError: false, timestamp: Date.now(),
  });
  const d2 = await turnOf(cfg, model, ctx);
  if (d2.stopReason !== "stop") fail(`fold mid-flight resume stopReason ${d2.stopReason}: ${d2.errorMessage ?? ""}`);

  // Between turns the same masking must pass equally unnoticed.
  const t2 = ctx.messages.map((m) => m.role).lastIndexOf("toolResult");
  ctx.messages[t2] = { ...ctx.messages[t2], content: [{ type: "text", text: "{#ab14 FOLDED} add tool result" }] };
  ctx.messages.push(d2, { role: "user", content: "add 6 and 2", timestamp: Date.now() });
  const r3 = await round("round 3");
  ctx.messages.push(r3.pause, {
    role: "toolResult", toolCallId: r3.call.id, toolName: r3.call.name,
    content: [{ type: "text", text: "8" }], isError: false, timestamp: Date.now(),
  });
  const d3 = await turnOf(cfg, model, ctx);
  if (d3.stopReason !== "stop") fail(`fold round 3 resume stopReason ${d3.stopReason}: ${d3.errorMessage ?? ""}`);
  console.log("pi_smoke fold: OK");
  process.exit(0);
}

if (phase === "--image") {
  // A Pi image block must reach the wire as an Anthropic base64 source
  // block, and the echoed history must still prefix-match next turn.
  const { id, config: cfg } = await loadProvider();
  const model = { id: cfg.models[0].id, api: "pi-with-claude", provider: id };
  const ctx = {
    systemPrompt: "You are a test.",
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "what is this?" },
        { type: "image", data: "iVBORw0KGgoAAAANSUhEUg", mimeType: "image/png" },
      ],
      timestamp: Date.now(),
    }],
  };
  const m1 = await turnOf(cfg, model, ctx);
  if (m1.stopReason !== "stop") fail(`image turn 1 stopReason ${m1.stopReason}: ${m1.errorMessage ?? ""}`);
  ctx.messages.push(m1, { role: "user", content: "thanks", timestamp: Date.now() });
  const m2 = await turnOf(cfg, model, ctx);
  if (m2.stopReason !== "stop") fail(`image turn 2 stopReason ${m2.stopReason}: ${m2.errorMessage ?? ""}`);
  console.log("pi_smoke image: OK");
  process.exit(0);
}

if (phase === "--swap") {
  // A model swap must reopen the session with the new model pinned —
  // never keep streaming on the old one. The parent asserts the trace
  // and the fake's argv.
  const { id, config: cfg } = await loadProvider();
  const model = { id: cfg.models[0].id, api: "pi-with-claude", provider: id };
  const ctx = { systemPrompt: "You are a test.", messages: [{ role: "user", content: "one", timestamp: Date.now() }] };
  const m1 = await turnOf(cfg, model, ctx);
  if (m1.stopReason !== "stop") fail(`swap turn 1 stopReason ${m1.stopReason}: ${m1.errorMessage ?? ""}`);
  ctx.messages.push(m1, { role: "user", content: "and again", timestamp: Date.now() });
  const swappedModel = { ...model, id: cfg.models[1].id };
  const m2 = await turnOf(cfg, swappedModel, ctx);
  if (m2.stopReason !== "stop") fail(`swap turn 2 stopReason ${m2.stopReason}: ${m2.errorMessage ?? ""}`);
  if (m2.model !== swappedModel.id) fail(`swap turn 2 model ${m2.model}, want ${swappedModel.id}`);
  console.log("pi_smoke swap: OK");
  process.exit(0);
}

if (phase === "--effort") {
  // Pi hands the level down as options.reasoning; it must reach the
  // spawned CLI as --effort, a change reopens, and an unsupported
  // level sends no flag at all.
  const { id, config: cfg } = await loadProvider();
  const model = { id: cfg.models[0].id, api: "pi-with-claude", provider: id };
  const ctx = { systemPrompt: "You are a test.", messages: [{ role: "user", content: "one", timestamp: Date.now() }] };
  const e1 = await turnOf(cfg, model, ctx, { reasoning: "high" });
  if (e1.stopReason !== "stop") fail(`effort turn 1 stopReason ${e1.stopReason}: ${e1.errorMessage ?? ""}`);
  ctx.messages.push(e1, { role: "user", content: "two", timestamp: Date.now() });
  // pi's `minimal` has no CLI equivalent and folds onto low.
  const e2 = await turnOf(cfg, model, ctx, { reasoning: "minimal" });
  if (e2.stopReason !== "stop") fail(`effort turn 2 stopReason ${e2.stopReason}: ${e2.errorMessage ?? ""}`);
  ctx.messages.push(e2, { role: "user", content: "three", timestamp: Date.now() });
  // `off` is declared unsupported: no flag at all, not a guess at low.
  const e3 = await turnOf(cfg, model, ctx, { reasoning: "off" });
  if (e3.stopReason !== "stop") fail(`effort turn 3 stopReason ${e3.stopReason}: ${e3.errorMessage ?? ""}`);
  console.log("pi_smoke effort: OK");
  process.exit(0);
}

if (phase === "--account") {
  // Turn 1 runs on the ambient environment, the /pi-with-claude
  // Account menu picks entry b, and turn 2 must reopen with
  // CLAUDE_CONFIG_DIR routed to it. The parent asserts the fake's
  // environment and the persisted selection.
  const { id, config: cfg, commands } = await loadProvider();
  const model = { id: cfg.models[0].id, api: "pi-with-claude", provider: id };
  const cmd = commands.get("pi-with-claude");
  if (!cmd) fail("extension did not register the pi-with-claude command");
  const ctx = { systemPrompt: "You are a test.", messages: [{ role: "user", content: "one", timestamp: Date.now() }] };
  const m1 = await turnOf(cfg, model, ctx);
  if (m1.stopReason !== "stop") fail(`account turn 1 stopReason ${m1.stopReason}: ${m1.errorMessage ?? ""}`);

  const notes = [];
  let sawAccountMenu = false;
  await cmd.handler("", {
    hasUI: true,
    ui: {
      notify: (msg) => notes.push(msg),
      select: async (title, options) => {
        if (title === "pi-with-claude") return options[0]; // "Account"
        if (title !== "Account") fail(`unexpected menu ${JSON.stringify(title)}`);
        sawAccountMenu = true;
        if (options.length !== 2) fail(`Account menu offered ${options.length} row(s), want 2`);
        const row = options.find((o) => o.trim() === "b");
        if (!row) fail(`no roster row for account b in ${JSON.stringify(options)}`);
        return row;
      },
    },
  });
  if (!sawAccountMenu) fail("/pi-with-claude did not reach the Account submenu");
  if (!notes.some((n) => n.includes("pi-with-claude account:"))) fail(`no selection notice in ${JSON.stringify(notes)}`);

  ctx.messages.push(m1, { role: "user", content: "two", timestamp: Date.now() });
  const m2 = await turnOf(cfg, model, ctx);
  if (m2.stopReason !== "stop") fail(`account turn 2 stopReason ${m2.stopReason}: ${m2.errorMessage ?? ""}`);
  console.log("pi_smoke account: OK");
  process.exit(0);
}

if (phase === "--account-tools") {
  // Switching while a tool call is paused: the swap forces a fresh
  // session, which cannot answer a call it never made. The turn must
  // fail saying so — never the bare "nothing new to run" — and leave
  // the switch PENDING, so the next ordinary message performs it.
  const { id, config: cfg, commands } = await loadProvider();
  const model = { id: cfg.models[0].id, api: "pi-with-claude", provider: id };
  const cmd = commands.get("pi-with-claude");
  const ctx = {
    systemPrompt: "You are a test.",
    tools: [{ name: "add", description: "adds numbers", parameters: { type: "object" } }],
    messages: [{ role: "user", content: "add 2 and 3", timestamp: Date.now() }],
  };
  const p1 = await turnOf(cfg, model, ctx);
  if (p1.stopReason !== "toolUse") fail(`tool-pause setup stopReason ${p1.stopReason}`);
  const call = p1.content.find((c) => c.type === "toolCall");
  ctx.messages.push(p1, {
    role: "toolResult", toolCallId: call.id, toolName: call.name,
    content: [{ type: "text", text: "5" }], isError: false, timestamp: Date.now(),
  });

  await cmd.handler("", {
    hasUI: true,
    ui: {
      notify: () => {},
      select: async (title, options) =>
        title === "pi-with-claude" ? options[0] : options.find((o) => o.trim() === "b"),
    },
  });

  const p2 = await turnOf(cfg, model, ctx);
  if (p2.stopReason !== "error") fail(`switch-during-tool-pause stopReason ${p2.stopReason}, want error`);
  const msg = p2.errorMessage ?? "";
  if (msg.includes("nothing new to run")) fail(`unexplained failure surfaced to the user: ${msg}`);
  if (!msg.includes("still pending")) fail(`failure does not say the switch survives: ${msg}`);

  // The recovery the message promises must actually work.
  ctx.messages.push({ role: "user", content: "carry on", timestamp: Date.now() });
  const p3 = await turnOf(cfg, model, ctx);
  if (p3.stopReason === "error") fail(`recovery turn failed: ${p3.errorMessage}`);
  console.log("pi_smoke account-tools: OK");
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

function runStubPhase(flag, env = {}, { keep = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pwc-phase-"));
  const tracePath = join(dir, "trace.log");
  const wirePath = join(dir, "fake.log");
  // "{DIR}" in an env value resolves to the phase's temp dir, so a
  // phase can be handed paths inside its own sandbox.
  const resolved = Object.fromEntries(
    Object.entries(env).map(([k, v]) => [k, typeof v === "string" ? v.replaceAll("{DIR}", dir) : v]),
  );
  const child = spawnSync(process.execPath, [here, flag], {
    encoding: "utf-8",
    timeout: 120000,
    env: {
      ...process.env,
      PI_WITH_CLAUDE_CLAUDE: join(root, "tests", "fake_claude.py"),
      PI_WITH_CLAUDE_DEBUG: tracePath,
      FAKE_CLAUDE_LOG: wirePath,
      ...resolved,
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
  const kept = Object.fromEntries(
    keep.map((rel) => {
      try {
        return [rel, readFileSync(join(dir, rel), "utf-8").trim()];
      } catch {
        return [rel, null];
      }
    }),
  );
  rmSync(dir, { recursive: true, force: true });
  if (child.status !== 0) {
    fail(`${flag} phase exited ${child.status}: ${child.stderr?.slice(0, 500)} ${child.stdout?.slice(0, 300)}`);
  }
  return { trace, wire, dir, kept };
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
  // wrapped by the bridge into a one-element array) — never a preset.
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
  const { trace } = runStubPhase("--seeded");
  if (count(trace, /fresh start:/g) !== 1) fail(`seeded phase fresh-started ${count(trace, /fresh start:/g)} time(s), want exactly 1`);
  if (count(trace, /turn sent:/g) !== 2) fail(`seeded phase sent ${count(trace, /turn sent:/g)} turn(s), want 2`);
  if (count(trace, /reopening session/g) !== 0) fail("seeded phase reopened — resume regression");
}
{
  const { trace } = runStubPhase("--stale");
  if (count(trace, /stale tool_result between turns: reopening session/g) !== 1) {
    fail(`stale phase did not take the stale-restart path:\n${trace.slice(-800)}`);
  }
  if (count(trace, /fresh start:/g) !== 1) fail("stale phase must fresh-start exactly once");
}
{
  const { trace } = runStubPhase("--deny");
  if (count(trace, /tool pause: 1 call\(s\) parked/g) !== 1) fail("deny phase saw no tool pause");
  if (count(trace, /resumed 1 tool call\(s\)/g) !== 1) fail("deny phase saw no resume");
  if (count(trace, /reopening session/g) !== 0) fail("deny phase reopened — deny must flow as data");
}
for (const [flag, fixture, extra] of [
  ["--empty-thinking", "tool-call-turn-empty-thinking.jsonl"],
  ["--thinkless", "tool-call-turn-thinkless.jsonl"],
  ["--double-thinking", "tool-call-turn-double-thinking.jsonl"],
  // The dispatch gap is what the serial phase is about: without it the
  // fake's whole flush parses in one chunk and every park lands before
  // the turn loop sees the block, which hides the race.
  ["--serial-dispatch", "tool-call-turn-serial.jsonl", { FAKE_CLAUDE_CALL_DELAY_MS: "100" }],
]) {
  const { trace } = runStubPhase(flag, { FAKE_CLAUDE_FIXTURE: join(root, "fixtures", fixture), ...(extra ?? {}) });
  for (const [pattern, label] of [[/fresh start:/g, "fresh start"], [/reopening session/g, "reopen"]]) {
    if (count(trace, pattern) !== 0) fail(`${flag} took a ${label} — the mirror mismatched across the tool loop`);
  }
}
{
  // Park after 8 replayed frames: init, status, message_start, block
  // start, and two thinking deltas are through, so the abort lands
  // mid-stream with partial content to preserve.
  const { trace } = runStubPhase("--interrupt", { FAKE_CLAUDE_HOLD_AFTER: "8" });
  if (count(trace, /interrupt requested/g) !== 1) fail("interrupt phase never requested the interrupt");
  if (!/frame: result error_during_execution/.test(trace)) fail("interrupt phase saw no error_during_execution result");
  if (count(trace, /reopening session/g) !== 0) fail("interrupt phase reopened — an interrupt must not cost the session");
}
{
  const { trace } = runStubPhase("--steering");
  // Two withholds: the steering-only refusal filters it first, then
  // the completion turn withholds it from the resumed flight.
  if (count(trace, /withheld 1 steering message\(s\)/g) !== 2) {
    fail(`steering phase did not withhold the in-flight text twice:\n${trace.slice(-600)}`);
  }
  if (count(trace, /turn sent:/g) !== 2) fail("steering phase: want exactly 2 sent turns (opening + delivery)");
  if (count(trace, /turn resumed:/g) !== 1) fail("steering phase: want exactly 1 resumed turn");
  if (count(trace, /reopening session/g) !== 0) fail("steering phase reopened — withheld steering must not restart");
}
{
  const { trace, wire } = runStubPhase("--swap");
  if (count(trace, /model swap: reopening session/g) !== 1) fail("swap phase: want exactly 1 model-swap reopen");
  const models = wire
    .filter((o) => o.fake_argv)
    .map((o) => o.fake_argv[o.fake_argv.indexOf("--model") + 1]);
  if (models.join(",") !== "haiku,sonnet") fail(`fake claude spawned with --model ${models.join(",")}, want haiku,sonnet`);
}
{
  const { trace, wire } = runStubPhase("--effort");
  const efforts = wire
    .filter((o) => o.fake_argv)
    .map((o) => {
      const i = o.fake_argv.indexOf("--effort");
      return i < 0 ? "(none)" : o.fake_argv[i + 1];
    });
  if (efforts.join(",") !== "high,low,(none)") {
    fail(`fake claude spawned with --effort ${efforts.join(",")}, want high,low,(none)`);
  }
  if (count(trace, /effort change: reopening session/g) !== 2) {
    fail("effort phase: want exactly 2 effort-change reopens (high->low, low->off)");
  }
}
{
  // The roster is pinned through PI_WITH_CLAUDE_ACCOUNTS and the
  // selection state redirected to a sandbox XDG_CONFIG_HOME, so this
  // never reads or writes the developer's own accounts.
  const accountEnv = {
    PI_WITH_CLAUDE_ACCOUNTS: "a={DIR}/account-a,b={DIR}/account-b",
    XDG_CONFIG_HOME: "{DIR}/xdg",
    PI_WITH_CLAUDE_ACCOUNT: "",
    CLAUDE_CONFIG_DIR: "",
  };
  const { trace, wire, kept } = runStubPhase("--account", accountEnv, { keep: ["xdg/pi-with-claude/account"] });
  if (count(trace, /account swap: reopening session/g) !== 1) fail("account phase: want exactly 1 account-swap reopen");
  const dirs = wire.filter((o) => "fake_config_dir" in o).map((o) => o.fake_config_dir || "(none)");
  if (dirs.length !== 2 || dirs[0] !== "(none)" || !dirs[1]?.endsWith("account-b")) {
    fail(`fake claude saw CLAUDE_CONFIG_DIR ${dirs.join(",")}, want (none) then .../account-b`);
  }
  const persisted = kept["xdg/pi-with-claude/account"];
  if (!persisted?.endsWith("account-b")) fail(`persisted selection ${JSON.stringify(persisted)}, want .../account-b`);
}
{
  const { trace, wire } = runStubPhase("--account-tools", {
    PI_WITH_CLAUDE_ACCOUNTS: "a={DIR}/account-a,b={DIR}/account-b",
    XDG_CONFIG_HOME: "{DIR}/xdg",
    PI_WITH_CLAUDE_ACCOUNT: "",
    CLAUDE_CONFIG_DIR: "",
  });
  if (count(trace, /account swap: reopening session/g) !== 1) fail("account-tools phase: want exactly 1 reopen");
  const dirs = wire.filter((o) => "fake_config_dir" in o).map((o) => o.fake_config_dir || "(none)");
  if (!dirs.at(-1)?.endsWith("account-b")) {
    fail(`held switch never reached the child: CLAUDE_CONFIG_DIR ${dirs.join(",")}`);
  }
}

runStubPhase("--init-surface"); // asserts internally on the I6 error
{
  // turn-deltas fixture keeps both drift turns text-only; the phase is
  // about the reopen, not the tool loop.
  const { trace } = runStubPhase("--drift", { FAKE_CLAUDE_FIXTURE: join(root, "fixtures", "turn-deltas.jsonl") });
  if (count(trace, /tool set drift: reopening session/g) !== 1) {
    fail(`drift phase: want exactly 1 tool-set-drift reopen:\n${trace.slice(-600)}`);
  }
}
{
  const { trace } = runStubPhase("--fold");
  for (const [pattern, label] of [[/fresh start:/g, "fresh start"], [/reopening session/g, "reopen"]]) {
    if (count(trace, pattern) !== 0) fail(`fold phase took a ${label} — in-place masked history read as a rewrite`);
  }
  if (count(trace, /turn sent:/g) !== 3 || count(trace, /turn resumed:/g) !== 3) {
    fail(
      `fold phase: ${count(trace, /turn sent:/g)} sent / ${count(trace, /turn resumed:/g)} resumed, want 3/3`,
    );
  }
}
{
  const { trace, wire } = runStubPhase("--image");
  const content = wire.filter((o) => o.type === "user").flatMap((o) => o.message?.content ?? []);
  const img = content.find((c) => c?.type === "image");
  if (
    !img ||
    img.source?.type !== "base64" ||
    img.source?.media_type !== "image/png" ||
    img.source?.data !== "iVBORw0KGgoAAAANSUhEUg"
  ) {
    fail(`image never reached the wire as a base64 source block: ${JSON.stringify(content).slice(0, 300)}`);
  }
  for (const [pattern, label] of [[/fresh start:/g, "fresh start"], [/reopening session/g, "reopen"]]) {
    if (count(trace, pattern) !== 0) fail(`image phase took a ${label} — image history mismatched the mirror`);
  }
  if (count(trace, /turn sent:/g) !== 2) fail(`image phase sent ${count(trace, /turn sent:/g)} turn(s), want 2`);
}

console.log("pi_smoke: OK — all phases green");
