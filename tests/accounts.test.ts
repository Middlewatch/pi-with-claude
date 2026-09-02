// Account discovery against the fake's `auth status`: convention dirs
// under a scratch HOME, one logged out, one plain file that must not be
// probed. The roster is process-cached, so the file holds one test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

test("discovery probes every ~/.claude* dir concurrently and keeps the signed-in ones", async () => {
  const home = mkdtempSync(join(tmpdir(), "pwc-accounts-"));
  mkdirSync(join(home, ".claude"));
  mkdirSync(join(home, ".claude-work"));
  mkdirSync(join(home, ".claude-old"));
  writeFileSync(join(home, ".claude-old", "logged-out"), "");
  writeFileSync(join(home, ".claude.json"), "{}");
  process.env.HOME = home;
  process.env.PI_WITH_CLAUDE_CLAUDE = join(HERE, "fake_claude.py");
  process.env.FAKE_CLAUDE_AUTH_DELAY_MS = "400";
  delete process.env.PI_WITH_CLAUDE_ACCOUNTS;

  const { accounts } = await import("../src/accounts.ts");
  const started = Date.now();
  const roster = await accounts();
  const elapsed = Date.now() - started;
  assert.deepEqual(
    roster.map((a) => a.label),
    [".claude — .claude@fake (max)", ".claude-work — .claude-work@fake (max)"],
  );
  assert.ok(elapsed < 1000, `three 400 ms probes took ${elapsed} ms, so they ran serially`);
  assert.equal(await accounts(), roster, "the roster is cached for the process");
});
