// Projection: Pi messages -> the neutral message schema, plus the
// mirror-diff primitives. Pure functions, no SDK and no Pi imports —
// this is the module the unit tests drive.
//
// The neutral schema and the restart taxonomy are specified by
// docs/contracts/bridge-v1.md; the identity-keyed diff is ADR 0001.
// Ported 2026-08-31 from the retired claude-go's adapters/pi/
// extension.ts, where every branch below was proven in production.

type Json = any;

// The in-process MCP server every Pi tool is hosted under. Pi executes
// tools by its own registry names, so Pi-facing content carries the
// plain name and the projection restores the wire form.
export const MCP_SERVER = "pi";
export const wireToolName = (plain: string) => `mcp__${MCP_SERVER}__${plain}`;

// mcp__<server>__<name> -> <name>; anything else passes through.
export function plainToolName(wire: string): string {
  if (!wire.startsWith("mcp__")) return wire;
  const sep = wire.indexOf("__", 5);
  return sep === -1 ? wire : wire.slice(sep + 2);
}

// Pi assistant content -> neutral blocks. Used BOTH to project Pi's
// history and to normalise what the mirror notes, so the two forms are
// identical by construction (deriving the mirror from wire frames
// instead made them agree only by coincidence — the claude-go
// empty-thinking regression).
export function assistantBlocks(content: Json[]): Json[] {
  return content.map((c: Json) =>
    c.type === "text"
      ? { type: "text", text: c.text }
      : c.type === "thinking"
        ? { type: "thinking", text: c.thinking }
        : { type: "tool_call", id: c.id, name: wireToolName(c.name), input: c.arguments },
  );
}

export function projectMessages(messages: Json[]): Json[] {
  const out: Json[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      const blocks =
        typeof m.content === "string"
          ? [{ type: "text", text: m.content }]
          : m.content
              .filter((c: Json) => c.type === "text" || c.type === "image")
              .map((c: Json) =>
                c.type === "text"
                  ? { type: "text", text: c.text }
                  : { type: "image", media_type: c.mimeType, data: c.data },
              );
      out.push({ role: "user", blocks });
    } else if (m.role === "assistant") {
      out.push({ role: "assistant", blocks: assistantBlocks(m.content) });
    } else if (m.role === "toolResult") {
      out.push({
        role: "user",
        blocks: [
          {
            type: "tool_result",
            call_id: m.toolCallId,
            // Pi's text/image content blocks are byte-compatible with
            // the MCP content array the tool handler returns raw.
            content: m.content.filter((c: Json) => c.type === "text" || c.type === "image"),
            is_error: m.isError,
          },
        ],
      });
    }
  }
  return out;
}

// keyOf is the diff identity of a projected message. Folding extensions
// (context-fold) rewrite absorbed history IN PLACE — a stale tool_result's
// content or a thinking block's text masked to a short digest — while the
// stateful CLI keeps the original as the model's lived context and can
// never be reseeded with an edited transcript. So identity ignores exactly
// those two mutable-in-place fields: tool_result content (call_id names
// the lived event) and thinking text. A masked copy then diffs as
// already-absorbed history — no fresh session, no restart (ADR 0001). Set
// changes (messages added, removed, replaced — branch navigation,
// compaction) still diff as before.
export const keyOf = (msg: Json) =>
  JSON.stringify({
    role: msg.role,
    blocks: msg.blocks.map((b: Json) =>
      b.type === "tool_result"
        ? { type: b.type, call_id: b.call_id, is_error: b.is_error }
        : b.type === "thinking"
          ? { type: b.type }
          : b,
    ),
  });

// diffNew returns candidate minus (noted + dropped) as a multiset, in
// candidate order, plus whether any NOTED message is missing from the
// candidate — a Pi-side deletion of absorbed history (branch
// navigation, compaction) that a live session must not paper over.
// Dropped history going missing raises nothing: the model never saw it.
export function diffNew(
  candidate: Json[],
  noted: Json[],
  dropped: Map<string, number>,
): { fresh: Json[]; deleted: boolean } {
  const notedCounts = new Map<string, number>();
  for (const m of noted) {
    const k = keyOf(m);
    notedCounts.set(k, (notedCounts.get(k) ?? 0) + 1);
  }
  const droppedCounts = new Map(dropped);
  const fresh: Json[] = [];
  for (const m of candidate) {
    const k = keyOf(m);
    if ((notedCounts.get(k) ?? 0) > 0) {
      notedCounts.set(k, notedCounts.get(k)! - 1);
    } else if ((droppedCounts.get(k) ?? 0) > 0) {
      droppedCounts.set(k, droppedCounts.get(k)! - 1);
    } else {
      fresh.push(m);
    }
  }
  let deleted = false;
  for (const n of notedCounts.values()) if (n > 0) deleted = true;
  return { fresh, deleted };
}

// freshStart trims a projection to what a brand-new session can
// honestly receive: the trailing run of user messages (the newest
// input), minus any leading tool_results (their calls cannot exist in
// a fresh session, and an unclaimable tool_result would fail the turn).
export function freshStart(candidate: Json[]): Json[] {
  let cut = candidate.length;
  while (cut > 0 && candidate[cut - 1].role === "user") cut--;
  let slice = candidate.slice(cut);
  while (slice.length > 0 && slice[0].blocks.every((b: Json) => b.type === "tool_result")) slice = slice.slice(1);
  return slice;
}

export const isUserContent = (m: Json) => m.blocks.some((b: Json) => b.type === "text" || b.type === "image");

export const hasToolResult = (m: Json) => m.blocks.some((b: Json) => b.type === "tool_result");

// Neutral tool descriptors: the session-identity signature (a drifted
// set forces a reopen) and the shape the MCP server advertises.
export function projectTools(tools: Json[] | undefined): Json[] {
  return (tools ?? []).map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters ?? { type: "object" },
  }));
}
