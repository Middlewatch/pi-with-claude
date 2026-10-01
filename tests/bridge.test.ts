// Driver tests: src/bridge.ts against the scripted fake claude, spawned
// directly — the wire the extension rides in the smoke, minus Pi. The
// fake validates our frames against docs/contracts/ and exits 2 loudly
// on a malformed one, so a completed turn is itself a contract check.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Bridge, buildArgs, childEnv, DESCRIPTION_CAP, DESCRIPTION_CAP_VAR, makeMcpHandler, type ToolCallRequest } from "../src/bridge.ts";

// The bridge deliberately unrefs everything it owns (a session must
// never hold Pi's event loop open between turns), so between tests the
// loop can drain and node --test then cancels the rest of the file.
// One ref'd handle pins the loop for the file's duration.
const keepAlive = setInterval(() => {}, 1 << 30);
after(() => clearInterval(keepAlive));

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE = join(HERE, "fake_claude.py");
const FIXTURES = join(HERE, "..", "fixtures");

type Json = any;

function withTimeout<T>(p: Promise<T>, what: string, ms = 15000): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      const t = setTimeout(() => reject(new Error(`timed out: ${what}`)), ms);
      (t as Json).unref?.();
    }),
  ]);
}

// t.after guarantees teardown: a failing assertion must not leak a
// ref'd child that wedges the rest of the run.
function openFake(t: Json, overrides: Json = {}) {
  const log = join(mkdtempSync(join(tmpdir(), "bridge-test-")), "wire.log");
  const b = new Bridge({
    model: "haiku",
    systemPrompt: "You are the drill.",
    effort: "",
    tools: [],
    claudePath: FAKE,
    ...overrides,
    env: { FAKE_CLAUDE_LOG: log, ...(overrides.env ?? {}) },
  });
  b.ref(); // what the extension does for the duration of a turn
  t.after(() => {
    b.unref();
    b.close();
  });
  return { b, log };
}

// Drain frames until pred matches (the matching frame is included).
async function readUntil(b: Bridge, pred: (f: Json) => boolean): Promise<Json[]> {
  const frames: Json[] = [];
  for (let i = 0; i < 500; i++) {
    const f = await withTimeout(b.read(), `frame ${i} (got: ${frames.map((x) => x.type).join(",")})`);
    frames.push(f);
    if (f.type === "__closed" && !pred(f)) {
      throw new Error(`stream closed early: ${f.error ?? "(clean)"} after ${frames.map((x) => x.type).join(",")}`);
    }
    if (pred(f)) return frames;
  }
  throw new Error("500 frames without a match");
}

const wireLines = (log: string): Json[] =>
  readFileSync(log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

test("buildArgs emits the pinned contract argv", () => {
  assert.deepEqual(buildArgs({ model: "haiku", effort: "" }), [
    "--output-format", "stream-json", "--verbose", "--input-format", "stream-json",
    "--model", "haiku",
    "--tools", "",
    "--setting-sources=",
    "--strict-mcp-config",
    "--permission-mode", "bypassPermissions",
    "--include-partial-messages",
  ]);
  const withEffort = buildArgs({ model: "sonnet", effort: "xhigh" });
  const i = withEffort.indexOf("--effort");
  assert.ok(i > 0 && withEffort[i + 1] === "xhigh");
  assert.ok(i < withEffort.indexOf("--include-partial-messages"), "effort sits before the trailing flags (pinned order)");
  // An unknown level is refused before a spawn, per spawn-args.md.
  assert.throws(
    () => new Bridge({ model: "haiku", systemPrompt: "", effort: "turbo", tools: [], claudePath: "/bin/false" }),
    /unknown effort/,
  );
});

test("childEnv lifts the CLI's description cap unless the parent sets one", () => {
  assert.deepEqual(childEnv({ HOME: "/h" }, { CLAUDE_CONFIG_DIR: "/a" }), {
    [DESCRIPTION_CAP_VAR]: DESCRIPTION_CAP,
    HOME: "/h",
    CLAUDE_CONFIG_DIR: "/a",
  });
  assert.equal(childEnv({ [DESCRIPTION_CAP_VAR]: "4096" })[DESCRIPTION_CAP_VAR], "4096");
  assert.match(DESCRIPTION_CAP, /^[1-9][0-9]*$/, "the CLI accepts digits only");
});

test("mcp handler speaks the pinned dialect", async () => {
  const calls: ToolCallRequest[] = [];
  const tools = [{ name: "echo", description: "says it back", input_schema: { type: "object", properties: { text: { type: "string" } } } }];
  const h = makeMcpHandler(tools, (req) => calls.push(req));

  const init = await h({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} });
  assert.equal(init.result.protocolVersion, "2025-11-25");
  assert.equal(init.result.serverInfo.name, "pi");

  // The notification ack is pinned verbatim (oracle behaviour).
  assert.deepEqual(await h({ jsonrpc: "2.0", method: "notifications/initialized" }), {
    jsonrpc: "2.0", result: {}, id: 0,
  });

  const list = await h({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.deepEqual(list.result.tools, [
    {
      name: "echo",
      description: "says it back",
      inputSchema: tools[0].input_schema,
      execution: { taskSupport: "forbidden" },
    },
  ]);

  const unknownTool = await h({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "nope" } });
  assert.equal(unknownTool.error.code, -32602);
  const unknownMethod = await h({ jsonrpc: "2.0", id: 3, method: "resources/list" });
  assert.equal(unknownMethod.error.code, -32601);

  // A handler failure is an error-flagged result, never a session error.
  const failing = h({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "echo", arguments: { text: "x" } } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input.text, "x");
  calls[0].resolve({ content: [{ type: "text", text: "boom" }], isError: true });
  const failed = await failing;
  assert.deepEqual(failed.result, { content: [{ type: "text", text: "boom" }], isError: true });
});

test("text turn: initialize, streamed deltas, result; pinned frames on the wire", async (t) => {
  const { b, log } = openFake(t);
  await withTimeout(b.initialized, "initialize");

  // Control channel is live before any user input (contract timing).
  const usage = await withTimeout(b.getContextUsage(), "get_context_usage");
  assert.equal(usage.totalTokens, 869);

  b.pushUser([{ type: "text", text: "hello" }]);
  const frames = await readUntil(b, (f) => f.type === "result");
  const types = new Set(frames.map((f) => f.type + (f.subtype ? `/${f.subtype}` : "")));
  assert.ok(types.has("system/init"), "system/init replayed after the user frame");
  assert.ok(types.has("stream_event"), "partial deltas flowed");
  assert.ok(types.has("assistant"), "assistant frame flowed");
  assert.equal(frames.at(-1).subtype, "success");

  b.close();
  const closed = await withTimeout(b.read(), "post-close read");
  assert.equal(closed.type, "__closed");
  assert.equal(closed.error, undefined, "our own teardown is a clean close");
  assert.ok(b.dead());

  // The wire, as the fake received it: argv, then initialize before any
  // user frame, then the pinned user frame shape.
  const wire = wireLines(log);
  const argv = wire[0].fake_argv;
  assert.deepEqual(argv, buildArgs({ model: "haiku", effort: "" }));
  const init = wire[1];
  assert.equal(init.type, "control_request");
  assert.equal(init.request.subtype, "initialize");
  assert.deepEqual(init.request.systemPrompt, ["You are the drill."]);
  assert.equal(init.request.sdkMcpServers, undefined, "no hosted server declared without tools");
  const user = wire.find((l) => l.type === "user");
  assert.deepEqual(user, {
    type: "user",
    session_id: "",
    message: { role: "user", content: [{ type: "text", text: "hello" }] },
    parent_tool_use_id: null,
  });
});

test("tool turn: handshake, parked tools/call, resolve resumes the turn", async (t) => {
  const parked: ToolCallRequest[] = [];
  const { b, log } = openFake(t, {
    tools: [{ name: "echo", description: "says it back", input_schema: { type: "object" } }],
    onToolCall: (req: ToolCallRequest) => parked.push(req),
  });
  b.pushUser([{ type: "text", text: "use the tool" }]);

  // The fake blocks mid-segment awaiting our tools/call answer — the
  // park is the pause the host later resolves.
  await withTimeout(
    (async () => {
      while (parked.length === 0) await new Promise((r) => setTimeout(r, 10));
    })(),
    "tool call to park",
  );
  const call = parked[0];
  assert.equal(call.name, "echo");
  assert.deepEqual(call.input, { text: "tool drill" });
  assert.equal(call.toolUseId, "toolu_017CcwvakyxkfJWxtyJx1pgH"); // the fixture's _meta id

  call.resolve({ content: [{ type: "text", text: "echoed" }] });
  const frames = await readUntil(b, (f) => f.type === "result");
  assert.equal(frames.at(-1).subtype, "success");
  b.close();

  const wire = wireLines(log);
  assert.deepEqual(wire[1].request.sdkMcpServers, ["pi"]);
  // The dialect ran to completion: the fake validated initialize,
  // notifications/initialized, tools/list, and our tools/call result
  // (it exits 2 on any deviation), and our answer carried the content.
  const callResp = wire.find(
    (l) => l.type === "control_response" && l.response?.response?.mcp_response?.result?.content,
  );
  assert.deepEqual(callResp.response.response.mcp_response.result.content, [{ type: "text", text: "echoed" }]);
});

test("interrupt: receipt-acked, turn ends with the captured error result", async (t) => {
  const { b } = openFake(t, { env: { FAKE_CLAUDE_HOLD_AFTER: "3" } });
  b.pushUser([{ type: "text", text: "long one" }]);
  for (let i = 0; i < 3; i++) await withTimeout(b.read(), `held frame ${i}`);
  await withTimeout(b.interrupt(), "interrupt ack");
  const frames = await readUntil(b, (f) => f.type === "result");
  assert.equal(frames.at(-1).subtype, "error_during_execution");
  b.close();
});

test("unknown frames flow through the pump untouched; JSON scalars are dropped (I4)", async (t) => {
  const { b } = openFake(t, { env: { FAKE_CLAUDE_INJECT: join(FIXTURES, "unknown-event.jsonl") } });
  b.pushUser([{ type: "text", text: "hello" }]);
  const frames = await readUntil(b, (f) => f.type === "result");
  assert.ok(
    frames.some((f) => f.type === "zz_synthetic_future_event"),
    "the synthesized unheard-of frame reached the reader as data",
  );
  // The same fixture carries a `null` line and a bare string: neither
  // is a frame, and routing them used to throw inside the stdout listener.
  assert.ok(
    frames.every((f) => f !== null && typeof f === "object"),
    "a JSON scalar line reached the reader",
  );
});

test("a dead child surfaces as __closed with exit evidence", async () => {
  const b = new Bridge({ model: "haiku", systemPrompt: "", effort: "", tools: [], claudePath: "/bin/false" });
  b.ref();
  // No t.after here: __closed proves the child is already gone.
  const f = await withTimeout(b.read(), "__closed");
  assert.equal(f.type, "__closed");
  assert.match(f.error, /exit/);
  b.close();
});

test("an unspawnable claude surfaces as __closed, not a throw", async () => {
  const b = new Bridge({ model: "haiku", systemPrompt: "", effort: "", tools: [], claudePath: "/nonexistent/claude" });
  b.ref();
  const f = await withTimeout(b.read(), "__closed");
  assert.equal(f.type, "__closed");
  assert.match(f.error, /spawning/);
  b.close();
});
