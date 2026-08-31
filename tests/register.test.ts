// Registration surface under a stubbed Pi API: provider id, model
// roster, context windows, and the stub stream's event shape. The
// contextWindow values are live behavior, not cosmetics — Pi fires
// auto-compaction off them (see the roster comment in extension.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import register from "../src/extension.ts";

function captured() {
  let provider: any = null;
  register({
    registerProvider(id: string, config: any) {
      provider = { id, config };
    },
    registerCommand() {},
  } as any);
  return provider;
}

test("registers the pi-with-claude provider with the settled roster", () => {
  const p = captured();
  assert.ok(p, "extension did not call registerProvider");
  assert.equal(p.id, "pi-with-claude");
  assert.equal(typeof p.config.streamSimple, "function");
  assert.deepEqual(
    p.config.models.map((m: any) => m.id),
    ["haiku", "sonnet", "opus", "fable"],
  );
  const windows = Object.fromEntries(p.config.models.map((m: any) => [m.id, m.contextWindow]));
  assert.deepEqual(windows, { haiku: 200000, sonnet: 967000, opus: 1000000, fable: 1000000 });
  for (const m of p.config.models) {
    assert.equal(m.thinkingLevelMap.off, null, `${m.id}: 'off' must be hidden, not mapped`);
    assert.equal(m.thinkingLevelMap.minimal, "low");
  }
});

test("stub stream pushes start..done and resolves the result", async () => {
  const p = captured();
  const model = { id: p.config.models[0].id, api: "pi-with-claude", provider: p.id };
  const stream = p.config.streamSimple(model, {
    systemPrompt: "You are a test.",
    messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
  });
  const events: string[] = [];
  for await (const ev of stream) events.push(ev.type);
  const message = await stream.result();
  assert.equal(events[0], "start");
  assert.ok(events.includes("text_delta"));
  assert.equal(events[events.length - 1], "done");
  assert.equal(message.stopReason, "stop");
  assert.ok(message.content[0].text.length > 0);
});
