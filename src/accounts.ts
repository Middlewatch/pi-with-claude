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
// Runs under node's type stripping.

import { spawn } from "node:child_process";
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
// the bridge at a scripted fake in tests; discovery follows it so a test
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

// Ask the vendor binary who a config directory is logged in as. Resolves
// null for anything not usably logged in — an unrelated directory, a
// logged-out one, or a claude that failed to answer in time.
const PROBE_TIMEOUT_MS = 15000;

function probe(dir: string): Promise<{ email: string; plan: string } | null> {
  return new Promise((resolve) => {
    let out = "";
    const child = spawn(claudeBin(), ["auth", "status", "--json"], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: dir },
      stdio: ["ignore", "pipe", "ignore"],
    });
    const deadline = setTimeout(() => child.kill("SIGKILL"), PROBE_TIMEOUT_MS);
    child.stdout!.setEncoding("utf8").on("data", (chunk: string) => (out += chunk));
    child.on("error", () => {
      clearTimeout(deadline);
      resolve(null);
    });
    child.on("close", (code) => {
      clearTimeout(deadline);
      let status: any;
      try {
        status = code === 0 ? JSON.parse(out) : null;
      } catch {
        status = null;
      }
      if (status?.loggedIn !== true) return resolve(null);
      resolve({ email: status.email ?? "signed in", plan: status.subscriptionType ?? "" });
    });
  });
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

let cached: Promise<Account[]> | null = null;

// The roster. Probing spawns one short-lived `claude` per candidate, all
// at once, so the wait is one probe long; the result is cached for the
// process — a menu reopened mid-session is instant, and a login
// performed elsewhere lands on the next Pi start.
export function accounts(): Promise<Account[]> {
  if (cached) return cached;
  const env = fromEnv();
  if (env) return (cached = Promise.resolve(env));
  const home = homedir();
  return (cached = Promise.all(
    candidateDirs().map(async (dir) => {
      const who = await probe(dir);
      if (!who) return null;
      const name = dir.slice(home.length + 1);
      return { dir, label: `${name} — ${who.email}${who.plan ? ` (${who.plan})` : ""}` };
    }),
  ).then((rows) => rows.filter((a): a is Account => a !== null)));
}

// The selected config directory, or null for "whatever the environment
// already says" — the pre-account behaviour, and the answer whenever
// nothing has been chosen. PI_WITH_CLAUDE_ACCOUNT (a path, or a roster
// label) pins the choice and makes the menu read-only for the process.
export async function selected(): Promise<string | null> {
  const pin = process.env.PI_WITH_CLAUDE_ACCOUNT;
  if (pin) {
    const byLabel = (await accounts()).find((a) => a.label === pin || a.label.startsWith(`${pin} —`));
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
