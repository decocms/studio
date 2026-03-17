import type { GuidePrompt, GuideResource } from "./index";

export const prompts: GuidePrompt[] = [
  {
    name: "create-agent",
    description:
      "Create a new agent with the right connections and instructions.",
    text: `# Create agent

Goal: create a new agent that has a clear role, the correct connections, and instructions that are specific enough to be reliable.

Read docs://agents.md for naming and instruction guidelines. Read docs://platform.md if you need a refresher on connections, agents, or virtual tools.

Recommended tool order:
1. Use CONNECTIONS_LIST to inspect what capabilities already exist.
2. If the user names a specific connection, use CONNECTIONS_GET to verify details.
3. If requirements are ambiguous, use user_ask before creating anything.
4. Use VIRTUAL_MCP_CREATE with a focused title, description, connectionIds, and instructions.
5. Use VIRTUAL_MCP_GET to verify the saved configuration.

Checks:
- Confirm the agent's purpose, target user, and scope.
- Include only the connections relevant to that role.
- Ensure the title is specific and easy to distinguish from other agents.
- Write instructions using the docs://agents.md guidance, especially XML-structured sections and explicit workflows.
- Verify the created agent includes the intended connections and instructions before reporting success.
`,
  },
  {
    name: "update-agent",
    description:
      "Update an existing agent's scope, connections, or instructions.",
    text: `# Update agent

Goal: safely modify an existing agent without broadening its scope unintentionally.

Read docs://agents.md for naming and instruction guidelines. Read docs://platform.md if you need context on how agents relate to connections and virtual tools.

Recommended tool order:
1. Use VIRTUAL_MCP_LIST or VIRTUAL_MCP_GET to identify the target agent.
2. Use CONNECTIONS_LIST or CONNECTIONS_GET if the update changes connected capabilities.
3. If the requested change is unclear or materially changes behavior, use user_ask.
4. Use VIRTUAL_MCP_UPDATE with the smallest necessary change set.
5. Use VIRTUAL_MCP_GET to confirm the final state.

Checks:
- Preserve existing behavior unless the user explicitly wants it changed.
- If changing instructions, keep the role, workflows, and constraints aligned.
- If changing connections, verify the new set still matches the agent's purpose.
- Call out destructive or high-impact changes before applying them.
- Confirm the final agent definition matches the request.
`,
  },
];

export const resources: GuideResource[] = [
  {
    name: "agents",
    uri: "docs://agents.md",
    description:
      "Agent naming, instruction writing, and prompt-engineering guidance.",
    text: `# Agents

## Naming

- Use a short, role-first title.
- Prefer names that describe the responsibility, not the implementation.
- Good: "Support triage", "Inventory analyst", "Finance reviewer"
- Bad: "Agent 2", "Claude helper", "General assistant"

## Description

The description should explain:
- Who the agent is for
- What decisions or actions it owns
- What it should avoid doing

## Instruction writing principles

- Give the agent a narrow, defensible role.
- State what success looks like.
- Define expertise boundaries so it knows when to stop or escalate.
- Prefer concrete workflows over abstract guidance.
- Describe tool-use expectations when it should call tools instead of answering directly.

## State-of-the-art instruction pattern

Use XML-style sections for high-signal structure:

\`\`\`xml
<role>
You are the support triage agent for B2B merchants.
</role>

<capabilities>
- Investigate account issues using the connected CRM and ticketing tools.
- Summarize findings for a human support rep.
</capabilities>

<constraints>
- Do not issue refunds.
- Ask for confirmation before changing customer-facing state.
</constraints>

<workflows>
1. Read the latest ticket context.
2. Inspect the customer account.
3. Summarize the issue and propose the next action.
</workflows>
\`\`\`

### Persona definition

- Make identity explicit.
- State domain expertise clearly.
- Define tone only if it matters to the task.
- Avoid fake personality traits that do not improve execution.

### Markdown workflows

Use numbered workflows for multi-step tasks:

1. Gather the required context.
2. Validate assumptions with tools.
3. Perform the allowed action.
4. Report the result and any follow-up.

### Tool-use patterns

- Instruct the agent to inspect available capabilities before assuming.
- Explain when tools are mandatory versus when direct answers are acceptable.
- For multi-step workflows, tell the agent to chain tool calls instead of guessing intermediate state.

### Guardrails

- Require confirmation before destructive changes.
- Define scope limits explicitly.
- State what data the agent must not modify.
- Tell the agent when to escalate to a human or another workflow.

## Good vs bad instruction patterns

### Good

\`\`\`md
<role>
You are the release checklist agent for the engineering team.
</role>

<capabilities>
- Read deployment status, incident notes, and rollout metrics.
</capabilities>

<constraints>
- Never approve a rollout automatically.
- Ask for confirmation before triggering rollback steps.
</constraints>

<workflows>
1. Check current rollout status.
2. Review open incidents and deployment metrics.
3. Summarize risk and recommend proceed, pause, or rollback.
</workflows>
\`\`\`

Why it works:
- The role is narrow.
- The data sources are clear.
- The decision boundary is explicit.
- The workflow is operational, not vague.

### Bad

\`\`\`md
You are a very smart helpful assistant. Use tools if needed and do whatever the user asks.
\`\`\`

Why it fails:
- No domain boundary.
- No safety limits.
- No workflow.
- "If needed" gives no usable tool policy.
`,
  },
];
