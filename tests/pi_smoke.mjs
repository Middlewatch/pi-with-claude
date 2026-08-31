#!/usr/bin/env node
// The whole extension through REAL Pi, token-free: spawn `pi -p` with
// the extension loaded, the provider selected, and discovery disabled,
// then assert on what Pi prints and on the extension's debug trace.
//
// Ported from claude-go's tests/pi_smoke.mjs (which drove the extension
// under a stubbed Pi API); this successor drives the installed `pi`
// binary itself, per the spec's gate decision.
//
// S1 scope: the provider stub answers one -p turn end to end.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function fail(msg) {
  console.error(`pi_smoke: FAIL — ${msg}`);
  process.exit(1);
}

function piTurn(message, { env = {}, extraArgs = [] } = {}) {
  const args = [
    "-p",
    "--provider", "pi-with-claude",
    "--model", "haiku",
    "-e", join(root, "src", "index.ts"),
    "-ne", "-ns", "-np", "-nc", "--no-themes", "--no-session",
    ...extraArgs,
    message,
  ];
  return spawnSync("pi", args, {
    encoding: "utf-8",
    timeout: 120000,
    env: { ...process.env, PI_OFFLINE: "1", ...env },
  });
}

const r = piTurn("say hi");
if (r.status !== 0) {
  fail(`pi exited ${r.status}: ${r.stderr?.slice(0, 500)} ${r.stdout?.slice(0, 500)}`);
}
if (!r.stdout.includes("pi-with-claude scaffold: provider stub reply")) {
  fail(`stub reply not in pi output: ${r.stdout.slice(0, 500)}`);
}

console.log("pi_smoke: OK — stub provider answered one real `pi -p` turn");
