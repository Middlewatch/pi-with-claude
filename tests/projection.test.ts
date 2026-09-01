// The projection-diff/mirror module against the restart taxonomy of
// bridge-v1 §prefix-match (docs/contracts/bridge-v1.md):
// shrunk history, prefix mismatch, stale tool_result, in-flight user
// content, identity-keyed masks (ADR 0001), precision edges.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  diffNew,
  freshStart,
  hasToolResult,
  isUserContent,
  keyOf,
  plainToolName,
  projectMessages,
} from "../src/projection.ts";

const user = (text: string) => ({ role: "user", blocks: [{ type: "text", text }] });
const asst = (text: string) => ({ role: "assistant", blocks: [{ type: "text", text }] });
const toolRes = (id: string, text: string, isError = false) => ({
  role: "user",
  blocks: [{ type: "tool_result", call_id: id, content: [{ type: "text", text }], is_error: isError }],
});
const thinking = (text: string) => ({ role: "assistant", blocks: [{ type: "thinking", text }] });
const noDrops = new Map<string, number>();

test("absorbed history echoed back is not fresh", () => {
  const noted = [user("q"), asst("a")];
  const { fresh, deleted } = diffNew([user("q"), asst("a"), user("next")], noted, noDrops);
  assert.deepEqual(fresh, [user("next")]);
  assert.equal(deleted, false);
});

test("shrunk history reads as deletion", () => {
  const noted = [user("q"), asst("a")];
  const { deleted } = diffNew([user("q")], noted, noDrops);
  assert.equal(deleted, true);
});

test("an edited absorbed message reads as deletion plus fresh", () => {
  const noted = [user("q"), asst("a")];
  const { fresh, deleted } = diffNew([user("q"), asst("EDITED"), user("next")], noted, noDrops);
  assert.equal(deleted, true);
  assert.deepEqual(fresh, [asst("EDITED"), user("next")]);
});

test("a masked tool_result diffs as already absorbed (ADR 0001)", () => {
  const noted = [user("q"), toolRes("t1", "the real forty-line output")];
  const masked = [user("q"), toolRes("t1", "{#ab12 FOLDED} digest"), user("next")];
  const { fresh, deleted } = diffNew(masked, noted, noDrops);
  assert.equal(deleted, false);
  assert.deepEqual(fresh, [user("next")]);
});

test("a masked thinking text diffs as already absorbed (ADR 0001)", () => {
  const noted = [user("q"), thinking("long reasoning")];
  const { fresh, deleted } = diffNew([user("q"), thinking("{#ab13 FOLDED}"), user("next")], noted, noDrops);
  assert.equal(deleted, false);
  assert.deepEqual(fresh, [user("next")]);
});

test("identity still distinguishes call_id and is_error", () => {
  assert.notEqual(keyOf(toolRes("t1", "x")), keyOf(toolRes("t2", "x")));
  assert.notEqual(keyOf(toolRes("t1", "x")), keyOf(toolRes("t1", "x", true)));
  assert.equal(keyOf(toolRes("t1", "anything")), keyOf(toolRes("t1", "else")));
  assert.equal(keyOf(thinking("a")), keyOf(thinking("b")));
});

test("a duplicated (stale re-sent) tool_result surfaces as fresh", () => {
  const noted = [user("q"), toolRes("t1", "5")];
  const { fresh, deleted } = diffNew([user("q"), toolRes("t1", "5"), toolRes("t1", "5")], noted, noDrops);
  assert.equal(deleted, false);
  assert.deepEqual(fresh, [toolRes("t1", "5")]);
});

test("dropped history is subtracted and its absence raises nothing", () => {
  const dropped = new Map([[keyOf(asst("old answer")), 1]]);
  const { fresh, deleted } = diffNew([asst("old answer"), user("next")], [], dropped);
  assert.equal(deleted, false);
  assert.deepEqual(fresh, [user("next")]);
  const gone = diffNew([user("next")], [], dropped);
  assert.equal(gone.deleted, false);
  assert.deepEqual(gone.fresh, [user("next")]);
});

test("freshStart takes the trailing user run minus leading tool_results", () => {
  const candidate = [user("q"), asst("a"), toolRes("t1", "5"), user("follow"), user("up")];
  assert.deepEqual(freshStart(candidate), [user("follow"), user("up")]);
  assert.deepEqual(freshStart([user("q"), asst("a")]), []);
  assert.deepEqual(freshStart([asst("a"), toolRes("t1", "5")]), []);
});

test("in-flight classification: user content vs completions", () => {
  assert.equal(isUserContent(user("steer")), true);
  assert.equal(isUserContent(toolRes("t1", "5")), false);
  assert.equal(hasToolResult(toolRes("t1", "5")), true);
  const mixed = { role: "user", blocks: [...toolRes("t1", "5").blocks, { type: "text", text: "and also" }] };
  assert.equal(isUserContent(mixed), true);
  assert.equal(hasToolResult(mixed), true);
});

test("numeric identity follows JSON structural equality (1 == 1.0)", () => {
  const a = { role: "assistant", blocks: [{ type: "tool_call", id: "t", name: "n", input: { a: 1 } }] };
  const b = { role: "assistant", blocks: [{ type: "tool_call", id: "t", name: "n", input: { a: 1.0 } }] };
  assert.equal(keyOf(a), keyOf(b));
  const c = { role: "assistant", blocks: [{ type: "tool_call", id: "t", name: "n", input: { a: 2 } }] };
  assert.notEqual(keyOf(a), keyOf(c));
});

test("wire name round trip", () => {
  assert.equal(plainToolName("mcp__pi__add"), "add");
  assert.equal(plainToolName("mcp__calc__add"), "add");
  assert.equal(plainToolName("read"), "read");
});

test("projection is stable across repeated calls (mirror keys match)", () => {
  const piMessages = [
    { role: "user", content: "q", timestamp: 1 },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "" },
        { type: "toolCall", id: "t1", name: "add", arguments: { a: 2, b: 3 } },
      ],
      timestamp: 2,
    },
    { role: "toolResult", toolCallId: "t1", toolName: "add", content: [{ type: "text", text: "5" }], isError: false, timestamp: 3 },
  ];
  const once = projectMessages(piMessages).map(keyOf);
  const twice = projectMessages(piMessages).map(keyOf);
  assert.deepEqual(once, twice);
});
