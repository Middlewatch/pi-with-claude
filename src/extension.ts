// Pi extension: Claude Code as a Pi model provider, in-process on the
// Claude Agent SDK. Pi owns the harness — system prompt, tools,
// transcript; the extension runs `claude` as a stripped backend
// (DESIGN.md): `tools: []`, `settingSources: []`, string systemPrompt,
// the init tool surface asserted (I6). Pi's projected context goes out
// as SDK turns; SDK messages come back as Pi's assistant-message event
// stream. The extension's durable state is a mirror of what the live
// session has absorbed (src/projection.ts), so its projection is
// prefix-stable by construction whatever order Pi keeps its own context
// in; irreconcilable history takes the honest restart, never a replay.
//
// The real `claude` resolves through the SDK's own discovery;
// PI_WITH_CLAUDE_CLAUDE points it at a scripted fake in the gate.
//
// Runs under node's type stripping (node >= 22.18): runtime imports are
// node builtins, our own siblings, and the Agent SDK — never the Pi
// packages (type-only).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync } from "node:fs";
import {
  assistantBlocks,
  diffNew,
  freshStart,
  isUserContent,
  keyOf,
  plainToolName,
  projectMessages,
  wireNames,
} from "./projection.ts";

type Json = any;

// Optional file-sink tracing (Pi captures extension consoles):
// PI_WITH_CLAUDE_DEBUG=<path> appends one line per seam event.
const debug = process.env.PI_WITH_CLAUDE_DEBUG
  ? (...a: Json[]) => appendFileSync(process.env.PI_WITH_CLAUDE_DEBUG as string, a.map(String).join(" ") + "\n")
  : () => {};

// ---------------------------------------------------------------------
// A minimal AssistantMessageEventStream: push/end/result plus async
// iteration — the surface Pi consumes (verified against pi-ai
// dist/utils/event-stream.d.ts; nothing instanceof-checks it).

export function makeEventStream() {
  const queue: Json[] = [];
  const waiting: ((r: IteratorResult<Json>) => void)[] = [];
  let ended = false;
  let resolveResult!: (m: Json) => void;
  const finalResult = new Promise<Json>((r) => (resolveResult = r));
  return {
    push(ev: Json) {
      if (ev.type === "done") resolveResult(ev.message);
      if (ev.type === "error") resolveResult(ev.error);
      const w = waiting.shift();
      if (w) w({ value: ev, done: false });
      else queue.push(ev);
    },
    end() {
      ended = true;
      for (const w of waiting.splice(0)) w({ value: undefined, done: true });
    },
    result: () => finalResult,
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<Json>> {
          if (queue.length) return Promise.resolve({ value: queue.shift(), done: false });
          if (ended) return Promise.resolve({ value: undefined, done: true });
          return new Promise((r) => waiting.push(r));
        },
      };
    },
  };
}

// ---------------------------------------------------------------------
// The SDK session and its mirror.

class Session {
  q: Json;
  child: ChildProcess | null = null;
  msgs: Json[] = [];
  waiters: ((m: Json) => void)[] = [];
  closed = false;
  busy = false; // one streamSimple at a time: msgs/waiters are one shared FIFO
  modelId: string; // pinned at open; a swap forces a reopen
  effort: string; // pinned at open (argv-scoped); a change forces a reopen
  // The mirror: every neutral message the live session has absorbed, in
  // absorption order — accepted suffixes verbatim, then each turn's
  // assistant message as Pi will hand it back.
  noted: Json[] = [];
  // History deliberately never sent (resumed sessions, fresh-start
  // trims): subtracted from every diff so it is not re-flagged as new.
  dropped = new Map<string, number>();
  inFlight = false; // a model turn is paused on Pi-run tool calls

  private queue: Json[] = [];
  private wake: (() => void) | null = null;

  constructor(cfg: { model: string; systemPrompt: string; effort: string }) {
    this.modelId = cfg.model;
    this.effort = cfg.effort;
    const self = this;
    async function* prompt() {
      for (;;) {
        while (self.queue.length) yield self.queue.shift();
        if (self.closed) return;
        await new Promise<void>((r) => (self.wake = r));
      }
    }
    const options: Json = {
      model: cfg.model,
      systemPrompt: cfg.systemPrompt,
      // The Pipe profile (DESIGN.md): stripped backend, no vendor
      // builtins, no settings tree. Spike-proven floor: ~1,280 input
      // tokens for the first call.
      tools: [],
      settingSources: [],
      // Without an unconditional allow the CLI's own permission layer
      // silently denies in-process MCP calls before the handler runs
      // (spike finding). Pi owns gating; nothing to gate here.
      canUseTool: async (_name: string, input: Json) => ({ behavior: "allow", updatedInput: input }),
      includePartialMessages: true,
      env: { ...process.env },
      // Own the child spawn so the session cannot hold the host's event
      // loop open between turns: Pi's -p mode ends when the loop
      // drains, and stdin EOF is the CLI's own close signal, so orphan
      // cleanup is inherent. ref()/unref() below re-arm stdout only
      // while a turn is in flight.
      spawnClaudeCodeProcess: (se: Json) => {
        const child = spawn(se.command, se.args, {
          cwd: se.cwd,
          stdio: ["pipe", "pipe", "pipe"],
          env: se.env,
          signal: se.signal,
        });
        // Stdio pipes are Socket at runtime (ref/unref exist); the
        // Writable/Readable typings just don't carry them.
        child.unref();
        (child.stdin as Json)?.unref?.();
        (child.stdout as Json)?.unref?.();
        (child.stderr as Json)?.unref?.();
        this.child = child;
        return child;
      },
    };
    if (cfg.effort) options.effort = cfg.effort;
    if (process.env.PI_WITH_CLAUDE_CLAUDE) options.pathToClaudeCodeExecutable = process.env.PI_WITH_CLAUDE_CLAUDE;
    this.q = query({ prompt: prompt(), options });
    // The pump: every SDK message lands in one FIFO the current turn
    // reads from; the stream ending (or throwing) is delivered as a
    // frame so a waiting turn never hangs.
    (async () => {
      try {
        for await (const m of this.q) this.deliver(m);
        this.deliver({ type: "__closed" });
      } catch (error) {
        this.deliver({ type: "__closed", error: error instanceof Error ? error.message : String(error) });
      }
    })();
  }

  private deliver(m: Json) {
    const w = this.waiters.shift();
    if (w) w(m);
    else this.msgs.push(m);
  }

  read(): Promise<Json> {
    const m = this.msgs.shift();
    if (m !== undefined) return Promise.resolve(m);
    return new Promise((r) => this.waiters.push(r));
  }

  pushUser(content: Json[]) {
    this.queue.push({ type: "user", message: { role: "user", content }, parent_tool_use_id: null });
    this.wake?.();
    this.wake = null;
  }

  // The event loop holds only while a turn is in flight: ref on entry,
  // unref when the stream settles, so a host like `pi -p` can exit the
  // moment it is done while an awaiting caller is never starved.
  ref() {
    (this.child?.stdout as Json)?.ref?.();
  }

  unref() {
    (this.child?.stdout as Json)?.unref?.();
  }

  dead(): boolean {
    return this.closed || (this.child !== null && this.child.exitCode !== null);
  }

  close() {
    this.closed = true;
    this.wake?.();
    this.wake = null;
    try {
      this.q.close?.();
    } catch {}
  }
}

let session: Session | null = null;

// ---------------------------------------------------------------------
// Wire translation at the SDK boundary.

// SDK assistant content (Anthropic shape) -> Pi assistant content.
// Tool calls surface under their PLAIN names — Pi's tool registry knows
// "read", not "mcp__pi__read" — with the wire form remembered for the
// projection round trip.
function sdkContentToPi(blocks: Json[]): Json[] {
  const out: Json[] = [];
  for (const b of blocks) {
    if (b.type === "text") out.push({ type: "text", text: b.text ?? "" });
    else if (b.type === "thinking") out.push({ type: "thinking", thinking: b.thinking ?? "" });
    else if (b.type === "tool_use") {
      wireNames.set(b.id, b.name);
      out.push({ type: "toolCall", id: b.id, name: plainToolName(b.name), arguments: b.input ?? {} });
    }
    // Other block kinds (the wire moves): tolerated and not projected.
  }
  return out;
}

// One user turn on the wire from the sendable suffix: text and image
// blocks in suffix order, adjacent text newline-merged into one block,
// an empty merged run dropped (the API rejects empty text). tool_result
// blocks resolve paused handlers instead (S3) and never ride this.
function userContentOf(sendable: Json[]): Json[] {
  const content: Json[] = [];
  let textRun: string[] | null = null;
  const flush = () => {
    if (textRun && textRun.join("\n").length > 0) content.push({ type: "text", text: textRun.join("\n") });
    textRun = null;
  };
  for (const m of sendable) {
    for (const b of m.blocks) {
      if (b.type === "text") (textRun ??= []).push(b.text);
      else if (b.type === "image") {
        flush();
        content.push({ type: "image", source: { type: "base64", media_type: b.media_type, data: b.data } });
      }
    }
  }
  flush();
  return content;
}

// I6: the init tool surface must be exactly what was asked for — the
// hosted proxies and nothing of the vendor's own.
function assertInitSurface(initTools: Json[], expected: string[]) {
  const got = [...(initTools ?? [])].sort().join(",");
  const want = [...expected].sort().join(",");
  if (got !== want) {
    throw new Error(`pi-with-claude: init tool surface [${got}] != requested [${want}] (I6) — a CLI release reintroduced scaffolding or dropped a hosted tool`);
  }
}

const REASON_TO_STOP: Record<string, string> = {
  end_turn: "stop",
  tool_calls: "toolUse",
  interrupted: "aborted",
  error: "error",
};

// ---------------------------------------------------------------------
// Reasoning effort: Pi thinking level -> the CLI's effort level. Pi's
// own levels are off/minimal/low/medium/high/xhigh/max; the CLI takes
// low/medium/high/xhigh/max, so the ends differ: pi's `minimal` folds
// onto `low`, and `off` has no CLI equivalent at all — it maps to null
// so the picker hides it rather than silently treating it as low.
const EFFORT_BY_LEVEL: Record<string, string> = {
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};

const THINKING_LEVEL_MAP: Record<string, string | null> = { off: null, ...EFFORT_BY_LEVEL };

// Pi passes the level as options.reasoning. An absent or unknown value
// leaves the effort off entirely, which is the CLI's own default —
// never a guess at what the user meant.
function effortOf(options: Json): string {
  const level = options?.reasoning;
  if (typeof level !== "string") return "";
  return EFFORT_BY_LEVEL[level] ?? "";
}

// ---------------------------------------------------------------------
// streamSimple: one session turn per call.

function streamClaude(model: Json, context: Json, options?: Json) {
  debug("streamSimple called", model?.id, "messages:", context?.messages?.length, "tools:", context?.tools?.length);
  const stream = makeEventStream();

  (async () => {
    const output: Json = {
      role: "assistant",
      content: [],
      api: model.api ?? "pi-with-claude",
      provider: model.provider ?? "pi-with-claude",
      model: model.id,
      usage: {
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "pending",
      timestamp: Date.now(),
    };
    let s: Session | null = null;
    let ownsBusy = false;
    try {
      stream.push({ type: "start", partial: output });

      // Pi's provider payload seam (before_provider_request): expose
      // what this turn sends so observing extensions see the same
      // system prompt and messages. Observation only: a returned
      // replacement is not applied (I2, no rewriting on the way out).
      await options?.onPayload?.(
        { system: context.systemPrompt ?? "", messages: context.messages ?? [], model: model.id, tools: [] },
        model,
      );

      const effort = effortOf(options);
      const expectedInitTools: string[] = [];

      const openSession = (): Session => {
        debug("opening session:", model.id, effort || "(default effort)");
        return new Session({ model: model.id, systemPrompt: context.systemPrompt ?? "", effort });
      };
      const swapSession = (): Session => {
        if (s && ownsBusy) {
          s.busy = false;
          s.unref();
        }
        session?.close();
        session = openSession();
        session.busy = true;
        ownsBusy = true;
        session.ref();
        return session;
      };

      if (!session || session.dead()) {
        session = openSession();
      } else if (session.modelId !== model.id || session.effort !== effort) {
        // Model and effort are pinned at spawn (argv-scoped), so the
        // only convergent move is a full reopen — at the cost of a
        // fresh model context.
        debug(session.modelId !== model.id ? "model swap: reopening session" : "effort change: reopening session");
        session.close();
        session = openSession();
      }
      s = session;
      if (s.busy) throw new Error("pi-with-claude: concurrent turns on one session are unsupported");
      s.busy = true;
      ownsBusy = true;
      s.ref();

      const candidate = projectMessages(context.messages);
      let sendable: Json[] = [];

      // takeFreshStart resets the session bookkeeping to what a
      // brand-new claude session can honestly receive, and records
      // everything else in the dropped ledger so it is never
      // re-flagged as new.
      const takeFreshStart = () => {
        sendable = freshStart(candidate);
        s!.noted = [];
        s!.inFlight = false;
        const sendCounts = new Map<string, number>();
        for (const m of sendable) {
          const k = keyOf(m);
          sendCounts.set(k, (sendCounts.get(k) ?? 0) + 1);
        }
        const drop = new Map<string, number>();
        for (const m of candidate) {
          const k = keyOf(m);
          if ((sendCounts.get(k) ?? 0) > 0) sendCounts.set(k, sendCounts.get(k)! - 1);
          else drop.set(k, (drop.get(k) ?? 0) + 1);
        }
        s!.dropped = drop;
        debug("fresh start:", sendable.length, "sendable,", drop.size, "dropped key(s)");
      };

      const { fresh, deleted } = diffNew(candidate, s.noted, s.dropped);
      if (deleted) {
        // Pi rewrote absorbed history (branch navigation, compaction).
        // Continuing would misrepresent the model's lived context, so
        // reopen clean — the honest degraded mode.
        debug("absorbed history rewritten by host: reopening session");
        s = swapSession();
        takeFreshStart();
      } else if (fresh.some((m: Json) => m.role !== "user")) {
        // Fresh content no suffix can carry (assistant history): a
        // resumed Pi session on a new process, or a foreign assistant
        // message injected mid-session.
        if (s.noted.length === 0 && s.dropped.size === 0) {
          debug("resumed history on a fresh session: fresh start");
          takeFreshStart();
        } else {
          debug("foreign assistant history mid-session: reopening session");
          s = swapSession();
          takeFreshStart();
        }
      } else if (s.inFlight) {
        // While a model turn is paused on tool calls, only completions
        // may go down; steering text is withheld and — being absent
        // from the mirror — resurfaces as fresh suffix next call.
        sendable = fresh.filter((m: Json) => !isUserContent(m));
        if (sendable.length < fresh.length) debug("withheld", fresh.length - sendable.length, "steering message(s)");
      } else {
        sendable = fresh;
      }
      if (sendable.length === 0) throw new Error("pi-with-claude: nothing new to run in this turn");

      const content = userContentOf(sendable);
      if (content.length === 0) throw new Error("pi-with-claude: nothing new to run in this turn");
      s.pushUser(content);
      debug("turn sent:", s.noted.length, "noted +", sendable.length, "new");

      // Streaming state: one open block at a time on the claude wire.
      let openKind: "text" | "thinking" | null = null;
      const closeBlock = () => {
        if (!openKind) return;
        const i = output.content.length - 1;
        const blk = output.content[i];
        stream.push(
          openKind === "text"
            ? { type: "text_end", contentIndex: i, content: blk.text, partial: output }
            : { type: "thinking_end", contentIndex: i, content: blk.thinking, partial: output },
        );
        openKind = null;
      };
      const onDelta = (kind: "text" | "thinking", text: string) => {
        if (openKind !== kind) {
          closeBlock();
          openKind = kind;
          output.content.push(kind === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" });
          stream.push({ type: `${kind}_start`, contentIndex: output.content.length - 1, partial: output });
        }
        const i = output.content.length - 1;
        if (kind === "text") output.content[i].text += text;
        else output.content[i].thinking += text;
        stream.push({ type: `${kind}_delta`, contentIndex: i, delta: text, partial: output });
      };

      // The turn's authoritative assistant blocks: the CLI emits one
      // assistant frame per completed content block (characterized,
      // fixtures/turn-deltas.jsonl); their concatenation is the message
      // Pi stores and re-projects next turn.
      const turnBlocks: Json[] = [];
      let reason = "";

      for (;;) {
        const frame = await s.read();
        debug("frame:", frame.type, frame.subtype ?? frame.event?.type ?? "");
        if (frame.type === "stream_event") {
          const ev = frame.event;
          if (ev?.type === "content_block_delta") {
            if (ev.delta?.type === "text_delta") onDelta("text", ev.delta.text ?? "");
            else if (ev.delta?.type === "thinking_delta") onDelta("thinking", ev.delta.thinking ?? "");
          }
        } else if (frame.type === "assistant") {
          turnBlocks.push(...(frame.message?.content ?? []));
        } else if (frame.type === "system" && frame.subtype === "init") {
          assertInitSurface(frame.tools, expectedInitTools);
        } else if (frame.type === "result") {
          closeBlock();
          reason = frame.subtype === "success" ? "end_turn" : "error";
          // The accumulated assistant frames are authoritative: Pi
          // stores this exact structure and re-projects it next turn.
          output.content = sdkContentToPi(turnBlocks);
          s.noted.push(...sendable, { role: "assistant", blocks: assistantBlocks(output.content) });
          output.content.forEach((c: Json, i: number) => {
            if (c.type === "toolCall") {
              stream.push({ type: "toolcall_start", contentIndex: i, partial: output });
              stream.push({ type: "toolcall_end", contentIndex: i, toolCall: c, partial: output });
            }
          });
          if (frame.usage) {
            // Pi reads context occupancy out of this object in TWO
            // places (compaction threshold: totalTokens; pi-ai
            // silent-overflow: input + cacheRead), and both must agree
            // with the CLI's own accounting. The per-turn fields are
            // COST counters aggregating every request in a tool-loop
            // turn, so one occupancy number is published in every
            // field Pi reads. S4 replaces this aggregate estimate with
            // the CLI's own getContextUsage answer.
            const occupancy =
              (frame.usage.input_tokens ?? 0) +
              (frame.usage.output_tokens ?? 0) +
              (frame.usage.cache_read_input_tokens ?? 0) +
              (frame.usage.cache_creation_input_tokens ?? 0);
            output.usage.input = 0;
            output.usage.cacheRead = occupancy;
            output.usage.cacheWrite = 0;
            output.usage.output = frame.usage.output_tokens ?? 0;
            output.usage.totalTokens = occupancy;
          }
          output.stopReason = REASON_TO_STOP[reason] ?? "error";
          if (output.stopReason === "error") output.errorMessage = `pi-with-claude: turn ended ${frame.subtype}`;
          break;
        } else if (frame.type === "__closed") {
          throw new Error(`pi-with-claude: session stream ended mid-turn${frame.error ? `: ${frame.error}` : ""}`);
        }
        // system/status, rate_limit_event, unknown types: tolerated.
      }

      if (output.stopReason === "pending") throw new Error("session stream ended without a stop reason");
      if (output.stopReason === "error") throw new Error(output.errorMessage || "unknown session error");
      if (output.stopReason === "aborted") {
        // The event protocol routes aborts through `error`, never
        // `done` (pi-ai types.d.ts).
        stream.push({ type: "error", reason: "aborted", error: output });
      } else {
        stream.push({ type: "done", reason: output.stopReason, message: output });
      }
      stream.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    } finally {
      if (s && ownsBusy) {
        s.busy = false;
        s.unref();
      }
    }
  })();

  return stream;
}

// ---------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  debug("extension registering");
  pi.registerProvider("pi-with-claude", {
    name: "Claude Code (pi-with-claude)",
    // Placeholders: the spawned claude authenticates itself (I1);
    // nothing is ever sent to this URL or with this key.
    baseUrl: "sdk://pi-with-claude",
    apiKey: "unused-the-spawned-claude-authenticates-itself",
    api: "pi-with-claude",
    // Floating CLI aliases (`claude --help`): each id tracks the latest
    // model in its tier. Haiku stays first — the smoke and Pi's default
    // selection both take models[0]. Subscription-billed underneath;
    // the CLI's own cost estimate is surfaced separately (I7), so
    // Pi-side rates stay zero.
    // contextWindow is the CLI's OWN rawMaxTokens for that alias,
    // measured token-free against claude 2.1.226 (claude-go,
    // get_context_usage on a session that never sends a user message).
    // The CLI is what actually compacts, so its number is the one Pi's
    // gauge must agree with. Overstating is the dangerous direction:
    // too large a number means compaction never fires and a long
    // session dies on overflow. Sonnet's 967000 is verbatim what the
    // CLI reports (its own autocompact threshold sits 33000 below),
    // not a typo for 1000000 — do not "round it up" without a fresh
    // measurement.
    models: [
      { id: "haiku", name: "Claude Haiku via pi-with-claude", contextWindow: 200000 },
      { id: "sonnet", name: "Claude Sonnet via pi-with-claude", contextWindow: 967000 },
      { id: "opus", name: "Claude Opus via pi-with-claude", contextWindow: 1000000 },
      { id: "fable", name: "Claude Fable via pi-with-claude", contextWindow: 1000000 },
    ].map((model) => ({
      ...model,
      reasoning: true,
      // The CLI owns the thinking budget; what it exposes is an effort
      // level, which this map lines up with Pi's picker. A level Pi
      // shows here is one the spawned `claude` is actually given.
      thinkingLevelMap: THINKING_LEVEL_MAP,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      // Mirrors the CLI's default output cap
      // (CLAUDE_CODE_MAX_OUTPUT_TOKENS). Display-only on the Pi side:
      // no cap is sent, and the CLI's internal loop absorbs
      // truncation, so no "length" stop reaches Pi.
      maxTokens: 32000,
    })),
    // The cast is deliberate: pi-ai's AssistantMessageEventStream type
    // is nominal (private fields), but nothing instanceof-checks it and
    // the runtime surface is the duck type makeEventStream provides.
    // Constructing the real class would mean a runtime import of the Pi
    // packages, which this extension deliberately never does.
    streamSimple: streamClaude as Json,
  });
}
