#!/usr/bin/env node
// The whole extension through REAL Pi, token-free: spawn `pi -p` with
// the extension loaded, the provider selected, and discovery disabled;
// the Agent SDK spawns tests/fake_claude.py in place of the real
// `claude`. Assertions read what Pi prints, the extension's debug
// trace, and the fake's stdin log (the wire witness).
//
// Ported from claude-go's tests/pi_smoke.mjs (which drove the extension
// under a stubbed Pi API); this successor drives the installed `pi`
// binary itself, per the spec's gate decision.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function fail(msg) {
  console.error(`pi_smoke: FAIL — ${msg}`);
  process.exit(1);
}

// One `pi -p` run: returns { r, trace, wire } where trace is the
// extension's debug log and wire is every JSON line the fake saw on
// stdin (first line: its argv and environment).
function piTurn(messages, { env = {}, extraArgs = [] } = {}) {
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
    ...(Array.isArray(messages) ? messages : [messages]),
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

// --- S2 walking skeleton: one text turn — open, deltas, stop, usage.
{
  const { r, trace, wire } = piTurn("hello from pi");
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

  // The turn actually streamed: deltas before the result.
  const deltas = (trace.match(/frame: stream_event content_block_delta/g) ?? []).length;
  if (deltas < 3) fail(`only ${deltas} content_block_delta frames in trace — streaming path broken`);
  if (!/frame: result success/.test(trace)) fail(`no successful result frame in trace:\n${trace.slice(0, 800)}`);
  if ((trace.match(/turn sent:/g) ?? []).length !== 1) fail("expected exactly one turn sent");

  console.log("pi_smoke: OK — one text turn through real pi (open, deltas, stop)");
}
