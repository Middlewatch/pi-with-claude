// Pi extension: Claude Code as a Pi model provider, in-process on the
// native stream-json bridge (src/bridge.ts). Pi owns the
// harness — system prompt, tools, transcript; the extension runs
// `claude` as a stripped backend (AGENTS.md): no builtin tools, no
// setting sources, the init tool surface asserted (I6). Pi's projected
// context goes out as wire turns; wire frames come back as Pi's
// assistant-message event stream. The extension's durable state is a
// mirror of what the live session has absorbed (src/projection.ts), so
// its projection is prefix-stable by construction whatever order Pi
// keeps its own context in; irreconcilable history takes the honest
// restart, never a replay.
//
// The real `claude` resolves from PATH; PI_WITH_CLAUDE_CLAUDE points
// the bridge at a scripted fake in the gate.
//
// Runs under node's type stripping (node >= 22.18): runtime imports are
// node builtins and our own siblings — never the Pi packages
// (type-only), and no third-party dependency at all.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync } from "node:fs";
import {
  assistantBlocks,
  diffNew,
  freshStart,
  hasToolResult,
  isUserContent,
  plainToolName,
  projectMessages,
  projectTools,
  wireToolName,
} from "./projection.ts";
import { Bridge, type ToolCallRequest } from "./bridge.ts";
import type { Message } from "./projection.ts";
import { accounts, ambient, pinned, selectAccount, selected } from "./accounts.ts";

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
// One live claude child, driven over the bridge, and its mirror.

class Session {
  bridge: Bridge;
  closed = false;
  busy = false; // one streamSimple at a time: the bridge FIFO is shared
  modelId: string; // pinned at open; a swap forces a reopen
  effort: string; // pinned at open (argv-scoped); a change forces a reopen
  toolsSig: string; // registered tool set, pinned by the MCP handshake; drift forces a reopen
  configDir: string | null; // account pinned in the child's environment at spawn; a swap forces a reopen
  // The mirror: every neutral message the live session has absorbed, in
  // absorption order — accepted suffixes verbatim, then each turn's
  // assistant message as Pi will hand it back.
  noted: Message[] = [];
  // History deliberately never sent (resumed sessions, fresh-start
  // trims): subtracted from every diff so it is not re-flagged as new.
  dropped = new Map<string, number>();
  // The CLI's cost estimate is cumulative per session; per-turn cost is
  // the delta against this watermark (I7: an estimate, surfaced as the
  // CLI's own).
  lastCostUsd = 0;
  inFlight = false; // a model turn is paused on Pi-run tool calls
  initSeen = false; // the session's system/init frame arrived and passed I6
  // Parked tool calls: handlers blocking on promises a later Pi turn
  // resolves. Keyed by the model's tool_use id once known; a call the
  // CLI dispatched without its _meta id waits in parkedUnbound until
  // the pause binds it to a block by name.
  parkedById = new Map<string, ToolCallRequest>();
  parkedUnbound: ToolCallRequest[] = [];
  // tool_use blocks the stream delivered whose calls the CLI has not
  // dispatched yet. It dispatches hosted calls one at a time while the
  // model keeps streaming the later blocks (claude 2.1.258), so a
  // paused stretch hands Pi the calls that have handlers and these
  // open the next stretch's blocks.
  carried: Json[] = [];

  constructor(cfg: {
    model: string;
    systemPrompt: string;
    effort: string;
    tools: Json[];
    toolsSig: string;
    configDir: string | null;
  }) {
    this.modelId = cfg.model;
    this.effort = cfg.effort;
    this.toolsSig = cfg.toolsSig;
    this.configDir = cfg.configDir;
    this.bridge = new Bridge({
      model: cfg.model,
      systemPrompt: cfg.systemPrompt,
      effort: cfg.effort,
      tools: projectTools(cfg.tools),
      onToolCall: (req) => {
        if (this.closed) {
          // A dispatch racing the teardown parks nowhere: reject it
          // now, since cancelParked already ran.
          req.reject(new Error("pi-with-claude: session closed with a tool call in flight"));
          return;
        }
        if (req.toolUseId) this.parkedById.set(req.toolUseId, req);
        else this.parkedUnbound.push(req);
        // Wake the turn loop as a frame so the pause condition is
        // re-checked the moment a handler parks.
        this.bridge.deliver({ type: "__tool_parked", id: req.toolUseId, name: req.name });
      },
      // The account rides the child's environment: CLAUDE_CONFIG_DIR
      // selects which subscription `claude` authenticates as (I1: the
      // variable, never a credential). null keeps the ambient
      // environment — the pre-account behaviour.
      env: cfg.configDir ? { CLAUDE_CONFIG_DIR: cfg.configDir } : {},
    });
  }

  dead(): boolean {
    return this.closed || this.bridge.dead();
  }

  // Cancel every parked handler so nothing hangs across a restart or
  // close; the rejection surfaces to the CLI side, which this teardown
  // is ending anyway.
  cancelParked(reason: string) {
    for (const req of this.parkedById.values()) req.reject(new Error(reason));
    for (const req of this.parkedUnbound) req.reject(new Error(reason));
    this.parkedById.clear();
    this.parkedUnbound = [];
  }

  close() {
    this.closed = true;
    this.cancelParked("pi-with-claude: session closed with a tool call in flight");
    this.bridge.close();
  }
}

// What one registration owns: the live session, and the account the
// NEXT opened session authenticates as (null is the ambient
// environment). The account is read at the start of each turn, so a
// switch lands on a turn boundary rather than mid-session. `undefined`
// means not yet resolved: resolution can spawn a probe, and an
// extension factory may run in an invocation that never starts a
// session, so it waits for the first turn or the first menu.
type Provider = { session: Session | null; account: string | null | undefined };

const currentAccount = async (p: Provider): Promise<string | null> =>
  p.account === undefined ? (p.account = await selected()) : p.account;

// ---------------------------------------------------------------------
// Wire translation at the claude boundary.

// Wire assistant content (Anthropic shape) -> Pi assistant content.
// Tool calls surface under their PLAIN names — Pi's tool registry knows
// "read", not "mcp__pi__read" — with the wire form remembered for the
// projection round trip.
function wireContentToPi(blocks: Json[]): Json[] {
  const out: Json[] = [];
  for (const b of blocks) {
    if (b.type === "text") out.push({ type: "text", text: b.text ?? "" });
    else if (b.type === "thinking") out.push({ type: "thinking", thinking: b.thinking ?? "" });
    else if (b.type === "tool_use") {
      out.push({ type: "toolCall", id: b.id, name: plainToolName(b.name), arguments: b.input ?? {} });
    }
    // Other block kinds (the wire moves): tolerated and not projected.
  }
  return out;
}

// One user turn on the wire from the sendable suffix: text and image
// blocks in suffix order, adjacent text newline-merged into one block,
// an empty merged run dropped (the API rejects empty text). tool_result
// blocks resolve paused handlers instead and never ride this.
function userContentOf(sendable: Message[]): Json[] {
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
// Streamed content blocks: one open block at a time on the claude wire,
// keyed by kind and wire index — consecutive blocks of one kind are
// distinct blocks (fable 5.1 emits two thinking blocks back to back: an
// empty signed one, then the summary). A delta appends to the partial
// message and mirrors onto the event stream; close ends the open block.

function blockWriter(stream: ReturnType<typeof makeEventStream>, output: Json) {
  let openKind: "text" | "thinking" | null = null;
  let openIndex = -1;
  const close = () => {
    if (!openKind) return;
    const i = output.content.length - 1;
    const blk = output.content[i];
    stream.push(
      openKind === "text"
        ? { type: "text_end", contentIndex: i, content: blk.text, partial: output }
        : { type: "thinking_end", contentIndex: i, content: blk.thinking, partial: output },
    );
    openKind = null;
    openIndex = -1;
  };
  // A delta without a wire index continues the open block.
  const delta = (kind: "text" | "thinking", index: number | null, text: string) => {
    if (openKind !== kind || (index !== null && openIndex !== index)) {
      close();
      openKind = kind;
      openIndex = index ?? openIndex;
      output.content.push(kind === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" });
      stream.push({ type: `${kind}_start`, contentIndex: output.content.length - 1, partial: output });
    }
    const i = output.content.length - 1;
    if (kind === "text") output.content[i].text += text;
    else output.content[i].thinking += text;
    stream.push({ type: `${kind}_delta`, contentIndex: i, delta: text, partial: output });
  };
  return { delta, close };
}

// ---------------------------------------------------------------------
// streamSimple: one session turn per call.

function streamClaude(p: Provider, model: Json, context: Json, options?: Json) {
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
    let onAbort: (() => void) | null = null;
    try {
      stream.push({ type: "start", partial: output });

      // Pi's provider payload seam (before_provider_request): expose
      // what this turn sends so observing extensions see the same
      // system prompt and messages. Observation only: a returned
      // replacement is not applied (I2, no rewriting on the way out).
      const tools = context.tools ?? [];
      const toolsSig = JSON.stringify(projectTools(tools));
      await options?.onPayload?.(
        { system: context.systemPrompt ?? "", messages: context.messages ?? [], model: model.id, tools: projectTools(tools) },
        model,
      );

      // Resolved once per turn: a switch made mid-turn takes effect on
      // the next one, never under an in-flight session.
      const accountDir = await currentAccount(p);
      const effort = effortOf(options);
      const expectedInitTools: string[] = tools.map((t: Json) => wireToolName(t.name));
      let swapped = false; // this turn reopened for a model/account/effort/tool-set change

      const openSession = (): Session => {
        debug("opening session:", model.id, effort || "(default effort)", tools.length, "tool(s)");
        return new Session({
          model: model.id,
          systemPrompt: context.systemPrompt ?? "",
          effort,
          tools,
          toolsSig,
          configDir: accountDir,
        });
      };
      const swapSession = (): Session => {
        if (s && ownsBusy) {
          s.busy = false;
          s.bridge.unref();
        }
        p.session?.close();
        p.session = openSession();
        p.session.busy = true;
        ownsBusy = true;
        p.session.bridge.ref();
        return p.session;
      };

      if (!p.session || p.session.dead()) {
        p.session = openSession();
      } else if (
        p.session.modelId !== model.id ||
        p.session.effort !== effort ||
        p.session.toolsSig !== toolsSig ||
        p.session.configDir !== accountDir
      ) {
        // Model and effort are pinned at spawn (argv-scoped), the
        // account in the child's environment, and the tool surface by
        // the session's MCP handshake, so the only convergent move is a
        // full reopen — at the cost of a fresh model context.
        debug(
          p.session.configDir !== accountDir
            ? "account swap: reopening session"
            : p.session.modelId !== model.id
              ? "model swap: reopening session"
              : p.session.effort !== effort
                ? "effort change: reopening session"
                : "tool set drift: reopening session",
        );
        p.session.close();
        p.session = openSession();
        swapped = true;
      }
      s = p.session;
      if (s.busy) throw new Error("pi-with-claude: concurrent turns on one session are unsupported");
      // The event loop holds only while a turn is in flight: ref on
      // entry, unref when the stream settles, so a host like `pi -p`
      // can exit the moment it is done while an awaiting caller is
      // never starved.
      s.busy = true;
      ownsBusy = true;
      s.bridge.ref();

      // Esc maps to the CLI's control-channel interrupt — never a kill;
      // the interrupted turn surfaces as its error_during_execution
      // result below and is mapped back to Pi's aborted stop.
      onAbort = () => {
        debug("interrupt requested");
        p.session?.bridge.interrupt().catch(() => {});
      };
      options?.signal?.addEventListener("abort", onAbort, { once: true });

      const candidate = projectMessages(context.messages);
      let sendable: Message[] = [];
      let freshStarted = false; // a fresh session was forced; only trailing user input can ride it

      // takeFreshStart resets the session bookkeeping to what a
      // brand-new claude session can honestly receive, and records
      // everything else in the dropped ledger so it is never
      // re-flagged as new.
      const takeFreshStart = () => {
        freshStarted = true;
        const plan = freshStart(candidate);
        sendable = plan.sendable;
        s!.noted = [];
        s!.inFlight = false;
        s!.dropped = plan.dropped;
        debug("fresh start:", sendable.length, "sendable,", plan.dropped.size, "dropped key(s)");
      };

      const { fresh, deleted } = diffNew(candidate, s.noted, s.dropped);
      if (deleted) {
        // Pi rewrote absorbed history (branch navigation, compaction).
        // Continuing would misrepresent the model's lived context, so
        // reopen clean — the honest degraded mode.
        debug("absorbed history rewritten by host: reopening session");
        s = swapSession();
        takeFreshStart();
      } else if (fresh.some((m) => m.role !== "user")) {
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
        sendable = fresh.filter((m) => !isUserContent(m));
        if (sendable.length < fresh.length) debug("withheld", fresh.length - sendable.length, "steering message(s)");
      } else {
        sendable = fresh;
        if (sendable.some(hasToolResult)) {
          // A tool_result between turns answers a call whose turn
          // already ended — stale by the taxonomy, and the degraded
          // restart path answers it.
          debug("stale tool_result between turns: reopening session");
          s = swapSession();
          takeFreshStart();
        }
      }

      // Resume path: while a model turn is paused on tool calls, the
      // sendable suffix is completions — each resolves the parked
      // handler its call_id names, and the CLI turn continues in
      // place. An unknown or already-completed id is stale and takes
      // the honest restart with nothing applied.
      let resumed = false;
      if (s.inFlight && sendable.length > 0) {
        const completions = sendable.flatMap((m) => m.blocks.filter((b) => b.type === "tool_result"));
        const missing = completions.filter((c) => !s!.parkedById.has(c.call_id));
        if (missing.length > 0) {
          debug("unclaimable tool_result on the paused turn: reopening session");
          s = swapSession();
          takeFreshStart();
        } else {
          for (const c of completions) {
            const entry = s.parkedById.get(c.call_id)!;
            s.parkedById.delete(c.call_id);
            // Deny-as-data: an is_error result flows to the model as an
            // error-flagged MCP result and the turn continues
            // (characterized, fixtures/denied-tool-turn.jsonl).
            entry.resolve({ content: c.content ?? [], isError: !!c.is_error });
          }
          resumed = true;
          debug("resumed", completions.length, "tool call(s)");
        }
      }

      if (sendable.length === 0 && !resumed) {
        // Recoverable dead ends, each with a different recovery — so
        // the turn says which one it was rather than the symptom.
        if (freshStarted) {
          // Name the actual cause — a swap the user asked for reads very
          // differently from history moving underneath us, and blaming
          // the wrong one sends them hunting.
          const where = accountDir ? accountDir.split("/").pop() : "the inherited account";
          const cause = swapped
            ? `switching to ${where} / ${model.id}`
            : "history the model had already seen changed underneath this session, which";
          throw new Error(
            `pi-with-claude: ${cause} starts a fresh session, and a fresh session cannot answer a ` +
              "tool call that was already in flight. Nothing was sent" +
              (swapped ? " and the switch is still pending" : "") +
              " — send a message to start it.",
          );
        }
        if (s.inFlight) {
          throw new Error(
            "pi-with-claude: a tool call is in flight, so only its results can go down now. The " +
              "text is held and goes out with the next ordinary turn.",
          );
        }
        throw new Error("pi-with-claude: nothing new to run in this turn");
      }
      if (resumed) {
        s.inFlight = false;
        debug("turn resumed:", s.noted.length, "noted +", sendable.length, "completion(s)");
      } else {
        const content = userContentOf(sendable);
        if (content.length === 0) throw new Error("pi-with-claude: nothing new to run in this turn");
        s.bridge.pushUser(content);
        debug("turn sent:", s.noted.length, "noted +", sendable.length, "new");
      }

      const blocks = blockWriter(stream, output);

      // The turn's authoritative assistant blocks: the CLI emits one
      // assistant frame per completed content block (characterized,
      // fixtures/turn-deltas.jsonl); their concatenation is the message
      // Pi stores and re-projects next turn. A stretch opens with the
      // tool_use blocks the previous pause held back.
      const turnBlocks: Json[] = s.carried;
      s.carried = [];

      // finalizeTurn closes the stretch — at a tool-call pause or the
      // result — with the accumulated assistant frames as the
      // authoritative message Pi stores and re-projects next turn.
      const finalizeTurn = (reason: string) => {
        blocks.close();
        // A tool_use block with no parked handler is a call the CLI has
        // not dispatched to this host. At a tool-call pause such blocks
        // open the next stretch (the CLI dispatches serially). On any
        // other ending they are dropped, from Pi's copy too: the CLI
        // answered them itself (a name nothing hosts draws the CLI's own
        // tool_use_error, characterized 2026-09-05 against 2.1.258,
        // fixtures/unknown-tool-turn.jsonl), and a toolCall handed to Pi
        // is one Pi executes, fails, and answers with a stale tool_result
        // that costs the whole session.
        const unparked = (b: Json) => b.type === "tool_use" && !s!.parkedById.has(b.id);
        const handed = turnBlocks.filter((b: Json) => !unparked(b));
        s!.carried = reason === "tool_calls" ? turnBlocks.filter(unparked) : [];
        if (reason !== "tool_calls" && handed.length < turnBlocks.length) {
          debug("dropped", turnBlocks.length - handed.length, "tool_use block(s) the CLI answered itself");
        }
        if (reason === "interrupted" || handed.length === 0) {
          // An interrupted turn's trailing block never gets its
          // assistant frame; the delta-built content IS the partial
          // message the model lived, so it survives as-is.
        } else {
          // Recover reasoning the CLI streamed but reported empty in
          // its final frames (characterized: assistant frames can carry
          // a thinking block with no text while the deltas carried it).
          // Only streamed text no frame already carries is a candidate:
          // fable 5.1 at high effort answers with two thinking blocks —
          // an empty signed block, then the summary (characterized
          // 2026-09-02, fixtures/tool-call-turn-double-thinking.jsonl) —
          // and the summary must not be copied into the empty one. A
          // turn that never streamed thinking stays honestly empty —
          // nothing is invented.
          const framed = new Set(handed.filter((b: Json) => b.type === "thinking" && b.thinking).map((b: Json) => b.thinking));
          const unclaimed = output.content
            .filter((c: Json) => c.type === "thinking" && c.thinking && !framed.has(c.thinking))
            .map((c: Json) => c.thinking);
          output.content = wireContentToPi(handed);
          for (const c of output.content) {
            if (c.type === "thinking" && !c.thinking && unclaimed.length) c.thinking = unclaimed.shift();
          }
        }
        s!.inFlight = reason === "tool_calls";
        s!.noted.push(...sendable, { role: "assistant", blocks: assistantBlocks(output.content) });
        output.content.forEach((c: Json, i: number) => {
          if (c.type === "toolCall") {
            stream.push({ type: "toolcall_start", contentIndex: i, partial: output });
            stream.push({ type: "toolcall_end", contentIndex: i, toolCall: c, partial: output });
          }
        });
        output.stopReason = REASON_TO_STOP[reason] ?? "error";
      };

      // The pause condition: a tool_use block on the stream has a parked
      // handler. The CLI dispatches hosted calls one at a time —
      // tools/call k+1 only after result k — while the model keeps
      // streaming the later blocks (claude 2.1.258, characterized
      // 2026-09-02 from two frozen sessions; fixtures/
      // tool-call-turn-serial.jsonl). Waiting for every streamed block
      // to park would wait on a dispatch the CLI makes only after a
      // result Pi cannot produce until this stretch ends, so the
      // stretch hands over the calls that have handlers and carries the
      // rest. Handlers the CLI dispatched without a _meta tool_use id
      // are bound to blocks by name, input equality preferred — two
      // concurrent calls with the same name and input are
      // interchangeable by construction.
      const toolUseBlocks = () => turnBlocks.filter((b: Json) => b.type === "tool_use");
      const pauseReady = (): boolean =>
        toolUseBlocks().some(
          (b: Json) => s!.parkedById.has(b.id) || s!.parkedUnbound.some((e) => e.name === plainToolName(b.name)),
        );
      const bindParked = () => {
        for (const b of toolUseBlocks()) {
          if (s!.parkedById.has(b.id)) continue;
          const matches = s!.parkedUnbound.filter((e) => e.name === plainToolName(b.name));
          const exact = matches.find((e) => JSON.stringify(e.input) === JSON.stringify(b.input));
          const chosen = exact ?? matches[0];
          if (!chosen) continue;
          s!.parkedUnbound.splice(s!.parkedUnbound.indexOf(chosen), 1);
          s!.parkedById.set(b.id, chosen);
        }
      };

      // A pause is a stretch boundary, so the decision is made with the
      // stream still open. Blocks carried in from the previous stretch
      // may already have their handler.
      const tryPause = (): boolean => {
        if (!pauseReady()) return false;
        bindParked();
        finalizeTurn("tool_calls");
        debug("tool pause:", output.content.filter((c: Json) => c.type === "toolCall").length, "call(s) parked,", s!.carried.length, "carried");
        return true;
      };

      while (!tryPause()) {
        const frame = await s.bridge.read();
        debug("frame:", frame.type, frame.subtype ?? frame.event?.type ?? "");
        if (frame.type === "stream_event") {
          const ev = frame.event;
          if (ev?.type === "content_block_delta") {
            const index = typeof ev.index === "number" ? ev.index : null;
            if (ev.delta?.type === "text_delta") blocks.delta("text", index, ev.delta.text ?? "");
            else if (ev.delta?.type === "thinking_delta") blocks.delta("thinking", index, ev.delta.thinking ?? "");
          }
        } else if (frame.type === "assistant") {
          turnBlocks.push(...(frame.message?.content ?? []));
        } else if (frame.type === "system" && frame.subtype === "init") {
          assertInitSurface(frame.tools, expectedInitTools);
          s.initSeen = true;
        } else if (frame.type === "result") {
          // I6 holds only if the surface was actually checked: a CLI
          // that stopped announcing init would otherwise pass unasserted.
          if (!s.initSeen) throw new Error("pi-with-claude: turn ended with no system/init frame, tool surface unasserted (I6)");
          // An interrupted turn comes back as error_during_execution,
          // not a distinct subtype (docs/contracts/events.md); it is Pi's
          // aborted stop only when this host actually interrupted.
          finalizeTurn(
            frame.subtype === "success"
              ? "end_turn"
              : frame.subtype === "error_during_execution" && options?.signal?.aborted
                ? "interrupted"
                : "error",
          );
          // Pi reads context occupancy out of the usage object in TWO
          // places (compaction threshold: totalTokens; pi-ai
          // silent-overflow: input + cacheRead), and both must agree
          // with the CLI's own accounting. The result's per-turn token
          // fields are COST counters: they aggregate every request in a
          // tool-loop turn (iterations[] carries the split), so relayed
          // verbatim they compact a nearly-empty session. So ONE
          // occupancy number goes into every field Pi reads: the CLI's
          // own getContextUsage answer, with the aggregate as the
          // estimate of last resort. Booked as cache read because that
          // is what it is — the prompt lives in the CLI's session, not
          // in tokens Pi sent this turn.
          const cu = await s.bridge.getContextUsage().catch(() => null);
          const aggregate = frame.usage
            ? (frame.usage.input_tokens ?? 0) +
              (frame.usage.output_tokens ?? 0) +
              (frame.usage.cache_read_input_tokens ?? 0) +
              (frame.usage.cache_creation_input_tokens ?? 0)
            : 0;
          const occupancy = cu?.totalTokens || aggregate;
          debug("occupancy:", occupancy, cu?.totalTokens ? "(cli)" : "(aggregate)");
          output.usage.input = 0;
          output.usage.cacheRead = occupancy;
          output.usage.cacheWrite = 0;
          output.usage.output = frame.usage?.output_tokens ?? 0;
          output.usage.totalTokens = occupancy;
          if (typeof frame.total_cost_usd === "number") {
            output.usage.cost.total = Math.max(0, frame.total_cost_usd - s.lastCostUsd);
            s.lastCostUsd = frame.total_cost_usd;
          }
          if (output.stopReason === "error") output.errorMessage = `pi-with-claude: turn ended ${frame.subtype}`;
          break;
        } else if (frame.type === "__closed") {
          throw new Error(`pi-with-claude: session stream ended mid-turn${frame.error ? `: ${frame.error}` : ""}`);
        }
        // system/status, user echoes, rate_limit_event, unknown types:
        // tolerated. __tool_parked exists purely to re-run the pause
        // check at the top of the loop.
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
      if (onAbort) options?.signal?.removeEventListener("abort", onAbort);
      if (s && ownsBusy) {
        s.busy = false;
        s.bridge.unref();
      }
    }
  })();

  return stream;
}

// ---------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  debug("extension registering");
  const p: Provider = { session: null, account: undefined };
  pi.registerProvider("pi-with-claude", {
    name: "Claude Code (pi-with-claude)",
    // Placeholders: the spawned claude authenticates itself (I1);
    // nothing is ever sent to this URL or with this key.
    baseUrl: "spawn://pi-with-claude",
    apiKey: "unused-the-spawned-claude-authenticates-itself",
    api: "pi-with-claude",
    // Floating CLI aliases (`claude --help`): each id tracks the latest
    // model in its tier. Haiku stays first — the smoke and Pi's default
    // selection both take models[0]. Subscription-billed underneath;
    // the CLI's own cost estimate is surfaced separately (I7), so
    // Pi-side rates stay zero.
    // contextWindow is the CLI's OWN rawMaxTokens for that alias,
    // measured token-free against claude 2.1.252 on 2026-08-31
    // (get_context_usage over the bridge on a session that never sends
    // a user message; .local/evidence/2026-08-31-s3/windows.txt) and
    // re-confirmed unchanged against 2.1.258 on 2026-09-01, where the
    // fable alias began resolving to claude-fable-5-1
    // (.local/evidence/2026-09-01-repin-2.1.258/windows.txt). The
    // CLI is what actually compacts, so its number is the one Pi's
    // gauge must agree with. Overstating is the dangerous direction:
    // too large a number means compaction never fires and a long
    // session dies on overflow. Sonnet moved 967000 → 1000000 between
    // 2.1.226 and 2.1.252; change any of these only against a fresh
    // measurement.
    models: [
      { id: "haiku", name: "Claude Haiku via pi-with-claude", contextWindow: 200000 },
      { id: "sonnet", name: "Claude Sonnet via pi-with-claude", contextWindow: 1000000 },
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
    streamSimple: ((model: Json, context: Json, options?: Json) => streamClaude(p, model, context, options)) as Json,
  });

  // The child is session-scoped: /new, /resume, /fork, and exit all
  // pass here, and the next turn opens fresh from Pi's new history.
  pi.on("session_shutdown", async () => {
    p.session?.close();
    p.session = null;
  });

  pi.registerCommand("pi-with-claude", {
    description: "pi-with-claude settings (account)",
    getArgumentCompletions: (prefix: string) => {
      const items = ["account"].filter((v) => v.startsWith(prefix)).map((v) => ({ value: v, label: v }));
      return items.length > 0 ? items : null;
    },
    handler: async (args: string, ctx: Json) => {
      if (!ctx.hasUI) return;
      const section = args?.trim() || (await ctx.ui.select("pi-with-claude", ["Account"]));
      if (!section) return;
      if (section.toLowerCase() !== "account") {
        ctx.ui.notify(`pi-with-claude: unknown section ${JSON.stringify(section)}`, "warning");
        return;
      }
      await accountMenu(p, ctx);
    },
  });
}

// The Account submenu. Labels come from `claude auth status` (I1: the
// vendor's own status command, never a credential file). Selecting an
// account does not disturb the live session — the next turn sees the new
// value and reopens onto it.
async function accountMenu(p: Provider, ctx: Json) {
  const roster = await accounts();
  if (roster.length === 0) {
    ctx.ui.notify(
      "pi-with-claude: no signed-in accounts found. Log one in with " +
        "`CLAUDE_CONFIG_DIR=~/.claude-<name> claude auth login`, or set PI_WITH_CLAUDE_ACCOUNTS.",
      "warning",
    );
    return;
  }
  if (pinned()) {
    ctx.ui.notify(`pi-with-claude: account pinned by PI_WITH_CLAUDE_ACCOUNT (${await currentAccount(p)})`, "warning");
    return;
  }
  // With nothing selected the child runs on the ambient environment; mark
  // whichever roster entry that resolves to, so the menu shows what is
  // actually in force rather than an empty list.
  const active = (await currentAccount(p)) ?? ambient();
  const rows = roster.map((a) => ({ dir: a.dir, text: `${a.dir === active ? "● " : "  "}${a.label}` }));
  const choice = await ctx.ui.select("Account", rows.map((r) => r.text));
  if (!choice) return;
  const picked = rows.find((r) => r.text === choice);
  if (!picked || picked.dir === active) return;
  selectAccount(picked.dir);
  p.account = picked.dir;
  debug("account selected:", picked.dir);
  ctx.ui.notify(
    `pi-with-claude account: ${picked.text.slice(2)} — takes effect next turn (the model's context restarts).`,
    "info",
  );
}
