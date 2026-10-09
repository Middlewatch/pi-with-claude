// Discovery with CLAUDE_CONFIG_DIR inherited: a relocated default outside
// ~/.claude* (such as ~/agent-kit/claude) leads the roster and is not
// probed twice when it also matches the convention. Separate file: the
// roster is process-cached.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

test("an inherited CLAUDE_CONFIG_DIR is the first candidate, convention dirs follow", async () => {
  const home = mkdtempSync(join(tmpdir(), "pwc-accounts-env-"));
  mkdirSync(join(home, "agent-kit", "claude"), { recursive: true });
  mkdirSync(join(home, ".claude-work"));
  process.env.HOME = home;
  process.env.CLAUDE_CONFIG_DIR = join(home, "agent-kit", "claude");
  process.env.PI_WITH_CLAUDE_CLAUDE = join(HERE, "fake_claude.py");
  delete process.env.PI_WITH_CLAUDE_ACCOUNTS;

  const { accounts } = await import("../src/accounts.ts");
  const roster = await accounts();
  assert.deepEqual(
    roster.map((a) => a.label),
    // The fake derives the email from the dir's basename; the label's name part is home-relative.
    ["agent-kit/claude — claude@fake (max)", ".claude-work — .claude-work@fake (max)"],
  );
});
