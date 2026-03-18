import type { GuidePrompt, GuideResource } from "./index";

export const prompts: GuidePrompt[] = [
  {
    name: "agents-create",
    description: "Build a new agent for a specific role or workflow.",
    text: `# Create agent

Goal: create a new agent that has a clear role, the correct connections, and instructions that are specific enough to be reliable.

Read docs://agents.md for naming and instruction guidelines. Read docs://platform.md if you need a refresher on connections, agents, or virtual tools.

Recommended tool order:
1. Use COLLECTION_CONNECTIONS_LIST to inspect what capabilities already exist.
2. If the user names a specific connection, use COLLECTION_CONNECTIONS_GET to verify details.
3. If requirements are ambiguous, use user_ask before creating anything.
4. Use COLLECTION_VIRTUAL_MCP_CREATE with a focused title, description, connectionIds, and instructions.
5. Use COLLECTION_VIRTUAL_MCP_GET to verify the saved configuration.

Checks:
- Confirm the agent's purpose, target user, and scope.
- Include only the connections relevant to that role.
- Ensure the title is specific and easy to distinguish from other agents.
- Write instructions using the docs://agents.md guidance, especially XML-structured sections and explicit workflows.
- Verify the created agent includes the intended connections and instructions before reporting success.
`,
  },
  {
    name: "agents-update",
    description:
      "Modify an existing agent's behavior, connections, or instructions.",
    text: `# Update agent

Goal: safely modify an existing agent without broadening its scope unintentionally.

Read docs://agents.md for naming and instruction guidelines. Read docs://platform.md if you need context on how agents relate to connections and virtual tools.

Recommended tool order:
1. Use COLLECTION_VIRTUAL_MCP_LIST or COLLECTION_VIRTUAL_MCP_GET to identify the target agent.
2. Use COLLECTION_CONNECTIONS_LIST or COLLECTION_CONNECTIONS_GET if the update changes connected capabilities.
3. If the requested change is unclear or materially changes behavior, use user_ask.
4. Use COLLECTION_VIRTUAL_MCP_UPDATE with the smallest necessary change set.
5. Use COLLECTION_VIRTUAL_MCP_GET to confirm the final state.

Checks:
- Preserve existing behavior unless the user explicitly wants it changed.
- If changing instructions, keep the role, workflows, and constraints aligned.
- If changing connections, verify the new set still matches the agent's purpose.
- Call out destructive or high-impact changes before applying them.
- Confirm the final agent definition matches the request.
`,
  },
  {
    name: "writing-prompts",
    description: "Improve instructions for an agent or automation.",
    text: `# Writing instructions

Goal: rewrite or refine instructions for either an agent or an automation so they clearly describe the purpose, constraints, and workflows in a reliable format.

Read docs://agents.md for the instruction-writing pattern, XML-style structure, and workflow guidance. Read docs://automations.md if you are improving automation behavior rather than agent behavior.

Recommended tool order:
1. Identify whether the target is an agent or an automation.
2. For agents, use COLLECTION_VIRTUAL_MCP_LIST or COLLECTION_VIRTUAL_MCP_GET to inspect the current instructions.
3. For automations, use AUTOMATION_LIST or AUTOMATION_GET to inspect the current messages/instructions.
4. Review the current instructions against docs://agents.md.
5. If the intended purpose, audience, or boundaries are unclear, use user_ask before rewriting.
6. Rewrite the instructions with explicit XML-style sections such as <role>, <capabilities>, <constraints>, and <workflows>.
7. For agents, use COLLECTION_VIRTUAL_MCP_UPDATE to save the improved instructions.
8. For automations, use AUTOMATION_UPDATE to save the improved messages/instructions.
9. Re-read the updated entity with COLLECTION_VIRTUAL_MCP_GET or AUTOMATION_GET to verify the final stored version.

Checks:
- Make the purpose explicit in a <role> section.
- Detect whether the current instructions already contain a workflow. If they do, improve the workflow to be concrete, ordered, and operational. If they do not, add one.
- Keep workflows numbered and focused on real execution steps, not vague advice.
- Add or tighten constraints when the current instructions are too open-ended.
- Preserve the user's intended domain and responsibilities while improving clarity.
- If the target is an automation, keep the instructions aligned with the trigger and expected background execution behavior.
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

### Improving existing instructions

When revising an existing agent:
- Identify whether a usable workflow already exists.
- If the workflow exists but is vague, rewrite it into concrete ordered steps.
- If no workflow exists, add one that reflects how the agent should actually operate.
- Move generic purpose statements into a clear XML-style <role> section.
- Add <capabilities> and <constraints> sections when the current instructions blur what the agent should and should not do.

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
