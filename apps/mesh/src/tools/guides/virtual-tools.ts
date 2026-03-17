import type { GuidePrompt, GuideResource } from "./index";

export const prompts: GuidePrompt[] = [
  {
    name: "create-virtual-tool",
    description: "Create a sandboxed virtual tool for an agent.",
    text: `# Create virtual tool

Goal: add a focused JavaScript tool to an agent when built-in tools are insufficient.

Read docs://virtual-tools.md for code format, sandbox expectations, and schema guidance. Read docs://agents.md if you also need instruction-writing context for the parent agent.

Recommended tool order:
1. Use VIRTUAL_MCP_LIST or VIRTUAL_MCP_GET to identify the target agent.
2. Use VIRTUAL_TOOLS_LIST to avoid duplicate names and inspect the current tool set.
3. If behavior, schema, or the target agent is ambiguous, use user_ask.
4. Use VIRTUAL_TOOLS_CREATE with a clear name, description, input schema, JavaScript implementation, and connection_dependencies for any tools the code calls.
5. Use VIRTUAL_TOOLS_GET to verify the saved code and schema.

Checks:
- Prefer a virtual tool only when existing tools do not already solve the task directly.
- Keep the tool focused on one workflow.
- Make the input schema explicit and minimal.
- Ensure the code matches the sandbox signature from docs://virtual-tools.md.
- Verify the tool name is descriptive and does not collide with existing tools.
- Always set connection_dependencies to the list of connection IDs whose tools the code invokes, so the platform can sync and protect those downstream connections.
`,
  },
  {
    name: "update-virtual-tool",
    description:
      "Update a virtual tool's code or schema while preserving expected behavior.",
    text: `# Update virtual tool

Goal: modify an existing virtual tool safely and confirm the final definition is coherent.

Read docs://virtual-tools.md for schema and sandbox guidance.

Recommended tool order:
1. Use VIRTUAL_TOOLS_LIST or VIRTUAL_TOOLS_GET to locate the existing tool.
2. Use VIRTUAL_MCP_GET if you need more context about the parent agent.
3. Use user_ask if the requested behavior change is not precise.
4. Use VIRTUAL_TOOLS_UPDATE with the exact fields to change.
5. Use VIRTUAL_TOOLS_GET to confirm the final code and schema.

Checks:
- Preserve compatibility unless the user explicitly wants a breaking change.
- Keep code aligned with the declared input schema.
- Avoid broad refactors when a targeted update is enough.
- Confirm the updated tool still belongs on that agent and does not duplicate another tool.
`,
  },
];

export const resources: GuideResource[] = [
  {
    name: "virtual-tools",
    uri: "docs://virtual-tools.md",
    description:
      "Virtual tool code format, sandbox model, and schema conventions.",
    text: `# Virtual tools

## When to use them

Use virtual tools when:
- You need to chain multiple tool calls behind one reusable interface.
- You need lightweight transformation or orchestration logic.
- The agent should expose a simpler abstraction than the raw connection tools.

Do not use them when a single existing tool already solves the task.

## Sandbox contract

Virtual tools run as JavaScript in a sandbox with access to the agent's enabled tools.

\`\`\`javascript
export default async function (tools, args) {
  const result = await tools.some_tool({ id: args.id });
  return { result };
}
\`\`\`

### Arguments
- \`tools\`: an object of async functions representing available tools.
- \`args\`: validated input matching the declared input schema.

## Connection dependencies

When the code calls tools from specific connections, list those connection IDs in \`connection_dependencies\`. This metadata:
- Lets the platform sync and protect the downstream connections.
- Ensures the virtual tool breaks visibly if a dependency is removed.
- Is required for VIRTUAL_TOOLS_CREATE and can be updated via VIRTUAL_TOOLS_UPDATE.

## Input schema guidance

- Keep schemas narrow and explicit.
- Name fields after the task domain, not internal implementation details.
- Prefer simple shapes unless nested structure is necessary.
- The code must assume only schema-validated inputs are present.

## Output guidance

- Return structured JSON-friendly objects.
- Keep the output stable and useful for downstream prompts or automations.
- Avoid returning massive raw payloads when a summary is enough.

## Design patterns

### Good
- "summarize-latest-tickets"
- "prepare-order-brief"
- "sync-contact-and-log-note"

These are task-shaped and understandable.

### Bad
- "helper"
- "run-stuff"
- "tool2"

These do not communicate intent or scope.

## Safety

- Virtual tools can trigger consequential actions through underlying tools.
- Keep logic constrained and predictable.
- If the code performs destructive operations, the parent agent instructions should require confirmation.
`,
  },
];
