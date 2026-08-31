// The in-process MCP server hosting Pi's tools toward the CLI: the
// tool-inversion seam. The CLI believes it is calling MCP tools; each
// call parks on a promise the host's next Pi turn resolves with the
// real tool result — the pause/resume shape of bridge-v1, with live
// promises instead of wire correlation.
//
// The low-level MCP Server is used deliberately: Pi tools carry raw
// JSON schemas, and the Agent SDK's own tool() helper demands Zod. The
// SDK only ever calls instance.connect(transport) on what we hand it.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { MCP_SERVER } from "./projection.ts";

type Json = any;

export type ToolCallRequest = {
  // The CLI stamps the model's tool_use id into _meta
  // ("claudecode/toolUseId", characterized in
  // fixtures/tool-call-turn.jsonl); null when a future release drops it
  // and the caller falls back to name binding.
  toolUseId: string | null;
  name: string;
  input: Json;
  resolve: (result: { content: Json[]; isError?: boolean }) => void;
  reject: (error: Error) => void;
};

export function makeToolServer(tools: Json[], onCall: (req: ToolCallRequest) => void) {
  const server = new Server({ name: MCP_SERVER, version: "0.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t: Json) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: t.parameters ?? { type: "object" },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, (req: Json) => {
    return new Promise((resolve, reject) => {
      onCall({
        toolUseId: req.params?._meta?.["claudecode/toolUseId"] ?? null,
        name: req.params?.name ?? "",
        input: req.params?.arguments ?? {},
        resolve,
        reject,
      });
    });
  });
  return server;
}
