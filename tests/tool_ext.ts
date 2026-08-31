// Smoke-only Pi extension: one custom tool the real-Pi tool phase lets
// the (scripted) model call, closing the inversion loop end to end.
export default function (pi: any) {
  pi.registerTool({
    name: "add",
    label: "Add",
    description: "adds numbers",
    parameters: {
      type: "object",
      properties: { a: { type: "number" }, b: { type: "number" } },
    },
    async execute() {
      return { content: [{ type: "text", text: "5" }], details: {} };
    },
  });
}
