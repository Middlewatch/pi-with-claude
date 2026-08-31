// Account routing: which Claude subscription the spawned `claude`
// authenticates as.
//
// An account IS a config directory. Claude Code reads its whole config
// tree — credentials included — from $CLAUDE_CONFIG_DIR, so selecting an
// account is setting one environment variable on the spawned CLI.
// Nothing here opens, parses, or writes a credential file: logging in is
// `CLAUDE_CONFIG_DIR=<dir> claude auth login`, run by the owner, and the
// roster's labels come from the vendor's own `claude auth status --json`
// (I1).
//
// Discovery is by convention — `~/.claude` and `~/.claude-<name>` — so a
// subscription logged into a new directory appears in the menu with no
// configuration. PI_WITH_CLAUDE_ACCOUNTS overrides discovery entirely
// when the convention guesses wrong.
//
// Ported 2026-08-31 from claude-go adapters/pi/accounts.ts (env names
// renamed, otherwise verbatim). Runs under node's type stripping.

import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Account = {
  dir: string; // absolute CLAUDE_CONFIG_DIR
  label: string; // menu text
};

// Our own state, deliberately NOT under ~/.claude* — that namespace is
// the discovery glob's, and a state dir sitting in it would be probed as
// a config directory (and populated by the probe).
const stateDir = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "pi-with-claude");
const stateFile = join(stateDir, "account");

// The binary that answers `auth status`. PI_WITH_CLAUDE_CLAUDE points
// the SDK at a scripted fake in tests; discovery follows it so a test
// installation never probes the real one.
const claudeBin = () => process.env.PI_WITH_CLAUDE_CLAUDE || "claude";

// A config directory by convention: ~/.claude, or ~/.claude-<name>.
// ~/.claude.json is a file and excluded by the stat.
function candidateDirs(): string[] {
  const home = homedir();
  let entries: string[];
  try {
    entries = readdirSync(home);
  } catch {
    return [];
  }
  return entries
    .filter((n) => n === ".claude" || n.startsWith(".claude-"))
    .sort()
    .map((n) => join(home, n))
    .filter((p) => {
      try {
        return statSync(p).isDirectory();
      } catch {
        return false;
      }
    });
}

// Ask the vendor binary who a config directory is logged in as. Returns
// null for anything not usably logged in — an unrelated directory, a
// logged-out one, or a claude that failed to answer.
function probe(dir: string): { email: string; plan: string } | null {
  let out: string;
  try {
    const r = spawnSync(claudeBin(), ["auth", "status", "--json"], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: dir },
      encoding: "utf-8",
      timeout: 15000,
    });
    if (r.status !== 0 || !r.stdout) return null;
    out = r.stdout;
  } catch {
    return null;
  }
  let status: any;
  try {
    status = JSON.parse(out);
  } catch {
    return null;
  }
  if (status?.loggedIn !== true) return null;
  return { email: status.email ?? "signed in", plan: status.subscriptionType ?? "" };
}

// PI_WITH_CLAUDE_ACCOUNTS: `label=path` pairs separated by `:` or `,`.
// Set it to take full control of the roster; unset to discover by
// convention.
function fromEnv(): Account[] | null {
  const raw = process.env.PI_WITH_CLAUDE_ACCOUNTS;
  if (!raw) return null;
  const accounts: Account[] = [];
  for (const pair of raw.split(/[:,]/)) {
    if (!pair.trim()) continue;
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const label = pair.slice(0, eq).trim();
    const dir = pair.slice(eq + 1).trim();
    if (label && dir) accounts.push({ dir, label });
  }
  return accounts;
}

let cached: Account[] | null = null;

// The roster. Probing spawns one short-lived `claude` per candidate, so
// the result is cached for the process — a menu reopened mid-session is
// instant, and a login performed elsewhere lands on the next Pi start.
export function accounts(): Account[] {
  if (cached) return cached;
  const env = fromEnv();
  if (env) return (cached = env);
  const found: Account[] = [];
  for (const dir of candidateDirs()) {
    const who = probe(dir);
    if (!who) continue;
    const name = dir.slice(homedir().length + 1);
    found.push({ dir, label: `${name} — ${who.email}${who.plan ? ` (${who.plan})` : ""}` });
  }
  return (cached = found);
}

// The selected config directory, or null for "whatever the environment
// already says" — the pre-account behaviour, and the answer whenever
// nothing has been chosen. PI_WITH_CLAUDE_ACCOUNT (a path, or a roster
// label) pins the choice and makes the menu read-only for the process.
export function selected(): string | null {
  const pin = process.env.PI_WITH_CLAUDE_ACCOUNT;
  if (pin) {
    const byLabel = accounts().find((a) => a.label === pin || a.label.startsWith(`${pin} —`));
    return byLabel ? byLabel.dir : pin;
  }
  try {
    const saved = readFileSync(stateFile, "utf-8").trim();
    // A directory that has since disappeared must not silently route the
    // child at a dead path; fall back to ambient.
    if (saved && statSync(saved).isDirectory()) return saved;
  } catch {}
  return null;
}

export function pinned(): boolean {
  return !!process.env.PI_WITH_CLAUDE_ACCOUNT;
}

// What `claude` authenticates as when no selection is in force: an
// inherited CLAUDE_CONFIG_DIR, else the CLI's own default. Display only —
// the child is still spawned without an override in that case, so this
// never becomes a place we could get the default wrong.
export function ambient(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

export function selectAccount(dir: string): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(stateFile, dir + "\n");
}
