Tool Plugins

Overview
This agent loads tools from two places:
- Built-in tools registered in code.
- External tool plugins loaded from:
  - repo: agent/tools/plugins/*.mjs
  - user: ~/.ember-agent/tools/*.mjs

Plugin Shape
Each plugin should export a registerTools function:

export async function registerTools(registry) {
  registry.register({
    name: "your_tool",
    description: "Short, clear description.",
    parameters: {
      type: "object",
      properties: {
        example: { type: "string", description: "Example param" },
      },
      required: ["example"],
    },
    keywords: ["example", "keyword"],
    handler: async (args) => {
      // Do work here
      return { ok: true };
    },
  });
}

Notes
- Keep descriptions short. Small local models are sensitive to long prompts.
- Avoid heavy imports in plugins.
- Return structured JSON so the agent can reason about results.
