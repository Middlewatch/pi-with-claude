// Registration surface under a stubbed Pi API: provider id, model
// roster, context windows, and the stub stream's event shape. The
// contextWindow values are live behavior, not cosmetics — Pi fires
// auto-compaction off them (see the roster comment in extension.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import register from "../src/extension.ts";

function captured() {
  let provider: any = null;
  const events: string[] = [];
  register({
    registerProvider(id: string, config: any) {
      provider = { id, config };
    },
    registerCommand() {},
    on(event: string) {
      events.push(event);
    },
  } as any);
  return { provider, events };
}

test("registers a session_shutdown handler for the child", () => {
  assert.deepEqual(captured().events, ["session_shutdown"]);
});

test("registers the pi-with-claude provider with the settled roster", () => {
  const p = captured().provider;
  assert.ok(p, "extension did not call registerProvider");
  assert.equal(p.id, "pi-with-claude");
  assert.equal(typeof p.config.streamSimple, "function");
  assert.deepEqual(
    p.config.models.map((m: any) => m.id),
    ["haiku", "sonnet", "opus", "fable"],
  );
  const windows = Object.fromEntries(p.config.models.map((m: any) => [m.id, m.contextWindow]));
  assert.deepEqual(windows, { haiku: 200000, sonnet: 1000000, opus: 1000000, fable: 1000000 });
  for (const m of p.config.models) {
    assert.equal(m.thinkingLevelMap.off, null, `${m.id}: 'off' must be hidden, not mapped`);
    assert.equal(m.thinkingLevelMap.minimal, "low");
  }
});

test("projectMessages maps Pi shapes to the neutral schema", async () => {
  const { projectMessages } = await import("../src/projection.ts");
  const projected = projectMessages([
    { role: "user", content: "hi", timestamp: 1 },
    {
      role: "user",
      content: [
        { type: "text", text: "what is this?" },
        { type: "image", data: "AAAA", mimeType: "image/png" },
      ],
      timestamp: 2,
    },
    {
      role: "toolResult",
      toolCallId: "t1",
      toolName: "add",
      content: [{ type: "text", text: "5" }],
      isError: false,
      timestamp: 3,
    },
  ]);
  assert.deepEqual(projected, [
    { role: "user", blocks: [{ type: "text", text: "hi" }] },
    {
      role: "user",
      blocks: [
        { type: "text", text: "what is this?" },
        { type: "image", media_type: "image/png", data: "AAAA" },
      ],
    },
    {
      role: "user",
      blocks: [{ type: "tool_result", call_id: "t1", content: [{ type: "text", text: "5" }], is_error: false }],
    },
  ]);
});
