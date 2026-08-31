#!/usr/bin/env node
// The parity demo (spec Outcome): the same scripted multi-turn Pi
// session on the old claude-go provider and on pi-with-claude, compared
// row by row. NOT part of the gate: `run` drives the REAL `claude` and
// SPENDS SUBSCRIPTION TOKENS — owner's say-so only, evidence dated into
// the repo's .local/ surround.
//
//   node tests/parity_demo.mjs run claude-go      .local/parity/claude-go
//   node tests/parity_demo.mjs run pi-with-claude .local/parity/pi-with-claude
//   node tests/parity_demo.mjs compare .local/parity/claude-go .local/parity/pi-with-claude
//
// Scripted rows: multi-turn continuity, Pi-owned tool inversion, image
// passthrough, model switch via reopen, effort switch via reopen — with
// occupancy read from the recorded session file. Rows a script cannot
// drive stay a manual checklist, printed at the end of `compare`:
// interrupt (Esc), the account menu, folding as a no-op beside
// context-fold, honest restart on a history rewrite.

import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const [mode, a, b] = process.argv.slice(2);

const ROWS = [
  { name: "base turn", args: ["Reply with exactly: PARITY-ONE"] },
  {
    name: "tool inversion",
    args: ["-t", "add", "-e", join(root, "tests", "tool_ext.ts"),
      "Call the add tool with a=2 and b=3, then reply with only its result."],
  },
  { name: "image passthrough", args: [`@${join(root, "tests", "pixel.png")}`, "Name the color of the attached 1x1 image in one word."] },
  { name: "model switch (reopen)", model: "sonnet", args: ["Reply with exactly: PARITY-FOUR"] },
  { name: "effort switch (reopen)", thinking: "high", args: ["What is 2+2? Reply with the number only."] },
];

function die(msg) {
  console.error(`parity_demo: ${msg}`);
  process.exit(1);
}

if (mode === "run") {
  const provider = a;
  const outDir = b;
  if (!provider || !outDir) die("usage: run <provider> <outdir>");
  mkdirSync(outDir, { recursive: true });
  let first = true;
  for (const row of ROWS) {
    const args = [
      "-p",
      "--provider", provider,
      "--model", row.model ?? "haiku",
      "--thinking", row.thinking ?? "low",
      "--session-dir", outDir,
      ...(first ? ["-n", `parity-${provider}`] : ["-c"]),
      "-ns", "-np", "-nc",
      ...row.args,
    ];
    console.log(`\n== ${row.name}`);
    const r = spawnSync("pi", args, { encoding: "utf-8", timeout: 300000, stdio: ["inherit", "pipe", "pipe"] });
    process.stdout.write(r.stdout ?? "");
    if (r.status !== 0) die(`${row.name}: pi exited ${r.status}\n${r.stderr?.slice(0, 800)}`);
    first = false;
  }
  console.log(`\nparity_demo: run complete — session recorded in ${outDir}`);
  process.exit(0);
}

if (mode === "compare") {
  if (!a || !b) die("usage: compare <dirA> <dirB>");
  const summarize = (dir) => {
    const file = readdirSync(dir).find((f) => f.endsWith(".jsonl"));
    if (!file) die(`no session .jsonl in ${dir}`);
    const rows = [];
    for (const line of readFileSync(join(dir, file), "utf-8").split("\n")) {
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      // Tolerant extraction: any object in the entry with an assistant
      // role and a usage block is one model turn.
      const scan = (o) => {
        if (!o || typeof o !== "object") return;
        if (o.role === "assistant" && o.usage) {
          rows.push({
            model: o.model,
            stop: o.stopReason,
            occupancy: o.usage.totalTokens,
            gauge: (o.usage.input ?? 0) + (o.usage.cacheRead ?? 0),
            cost: o.usage.cost?.total,
            toolCalls: (o.content ?? []).filter((c) => c.type === "toolCall").length,
            text: (o.content ?? [])
              .filter((c) => c.type === "text")
              .map((c) => c.text)
              .join(" ")
              .slice(0, 48),
          });
          return;
        }
        for (const v of Object.values(o)) scan(v);
      };
      scan(obj);
    }
    return rows;
  };
  const A = summarize(a);
  const B = summarize(b);
  console.log(`\n${a} (${A.length} turns)  vs  ${b} (${B.length} turns)\n`);
  const n = Math.max(A.length, B.length);
  for (let i = 0; i < n; i++) {
    const [x, y] = [A[i], B[i]];
    const fmt = (t) =>
      t
        ? `model=${t.model} stop=${t.stop} occ=${t.occupancy} gauge=${t.gauge} tools=${t.toolCalls} cost=${t.cost?.toFixed?.(4) ?? "-"} "${t.text}"`
        : "(missing)";
    console.log(`turn ${i + 1}${ROWS[i] ? ` (${ROWS[i].name})` : ""}`);
    console.log(`  A: ${fmt(x)}`);
    console.log(`  B: ${fmt(y)}`);
    const flags = [];
    if (x && y) {
      if (x.stop !== y.stop) flags.push("STOP DIFFERS");
      if (x.model !== y.model) flags.push("MODEL DIFFERS");
      if ((x.toolCalls > 0) !== (y.toolCalls > 0)) flags.push("TOOL USE DIFFERS");
      if (x.occupancy !== x.gauge || y.occupancy !== y.gauge) flags.push("OCCUPANCY/GAUGE SPLIT");
      if (!(x.occupancy > 0) || !(y.occupancy > 0)) flags.push("OCCUPANCY MISSING");
    }
    if (flags.length) console.log(`  !! ${flags.join(", ")}`);
  }
  console.log(`
Manual checklist (owner-witnessed, both providers):
  [ ] interrupt: Esc mid-generation -> aborted stop, partial kept, next turn fine
  [ ] account menu: /claude-go vs /pi-with-claude Account -> switch lands next turn
  [ ] folding no-op: long tool session beside context-fold -> no context reset
  [ ] honest restart: branch-navigate history -> clean reopen, no replay
Any row that differs unexplained falsifies the parity claim (spec Outcome).`);
  process.exit(0);
}

die("usage: parity_demo.mjs run|compare ...");
