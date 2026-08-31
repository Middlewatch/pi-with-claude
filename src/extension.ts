// Pi extension: Claude Code as a Pi model provider, in-process on the
// Claude Agent SDK. Pi owns the harness — system prompt, tools,
// transcript; the extension runs `claude` as a stripped backend
// (DESIGN.md) and translates Pi's projected context to SDK turns.
//
// S1 scaffold: the provider registers with the settled model roster and
// streams a stub reply; the SDK-backed session lands in later slices
// (docs/specs/2026-08-31-pi-with-claude.md).
//
// Runs under node's type stripping (node >= 22.18): runtime imports are
// node builtins, our own siblings, and the Agent SDK — never the Pi
// packages (type-only).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Json = any;

// Optional file-sink tracing (Pi captures extension consoles):
// PI_WITH_CLAUDE_DEBUG=<path> appends one line per seam event.
import { appendFileSync } from "node:fs";
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

// ---------------------------------------------------------------------
// streamSimple, S1 stub: a canned reply proving the provider seam end
// to end under real Pi (tests/pi_smoke.mjs). Replaced by the SDK
// session in S2.

const STUB_TEXT = "pi-with-claude scaffold: provider stub reply";

function streamStub(model: Json, context: Json, options?: Json) {
  debug("streamSimple called", model?.id, "messages:", context?.messages?.length);
  const stream = makeEventStream();
  (async () => {
    const output: Json = {
      role: "assistant",
      content: [{ type: "text", text: "" }],
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
    stream.push({ type: "start", partial: output });
    stream.push({ type: "text_start", contentIndex: 0, partial: output });
    output.content[0].text = STUB_TEXT;
    stream.push({ type: "text_delta", contentIndex: 0, delta: STUB_TEXT, partial: output });
    stream.push({ type: "text_end", contentIndex: 0, content: STUB_TEXT, partial: output });
    output.stopReason = "stop";
    stream.push({ type: "done", reason: "stop", message: output });
    stream.end();
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
    streamSimple: streamStub as Json,
  });
}
