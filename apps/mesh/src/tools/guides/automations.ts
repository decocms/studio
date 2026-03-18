import type { GuidePrompt, GuideResource } from "./index";

export const prompts: GuidePrompt[] = [
  {
    name: "automations-create",
    description:
      "Set up a background workflow that runs on a schedule, event, or webhook.",
    text: `# Create automation

Goal: create a background workflow that runs the right agent with the correct trigger model.

Read docs://automations.md for trigger types and workflow patterns. Read docs://platform.md if you need context on how automations relate to agents.

Recommended tool order:
1. Use COLLECTION_VIRTUAL_MCP_LIST or COLLECTION_VIRTUAL_MCP_GET to identify the agent that should run.
2. If the trigger type or payload is unclear, use user_ask.
3. Use AUTOMATION_CREATE with a clear title, description, and agent.
4. Use AUTOMATION_TRIGGER_ADD to attach the schedule, event trigger, or webhook.
5. Use AUTOMATION_GET to verify the saved automation and trigger state.
6. Optionally use AUTOMATION_RUN to test the automation when appropriate.

Checks:
- Match the trigger type to the user's intent: schedule, event, or webhook.
- Confirm cron expressions and event names before saving them.
- Make sure the selected agent has the required connections and tools.
- If a manual test is safe, run it and report the result.
`,
  },
  {
    name: "automations-update",
    description: "Change an automation's triggers, agent, or configuration.",
    text: `# Update automation

Goal: change an automation's configuration safely and verify the final behavior.

Read docs://automations.md for trigger semantics and design patterns.

Recommended tool order:
1. Use AUTOMATION_LIST or AUTOMATION_GET to locate the automation.
2. Use COLLECTION_VIRTUAL_MCP_GET if you need to confirm the assigned agent context.
3. Use user_ask if the requested trigger or behavior change is not exact.
4. Use AUTOMATION_UPDATE for metadata or agent changes.
5. Use AUTOMATION_TRIGGER_ADD then AUTOMATION_TRIGGER_REMOVE if the trigger itself must change (add before remove so the automation is never left untriggered if the add fails).
6. Use AUTOMATION_GET to confirm the final state.
7. Optionally use AUTOMATION_RUN to validate the updated workflow.

Checks:
- Treat trigger changes as consequential because they alter future executions.
- Be explicit about whether an old trigger is being replaced or removed.
- Verify the updated automation still points to the intended agent.
- If the workflow is testable, validate it after the change.
`,
  },
];

export const resources: GuideResource[] = [
  {
    name: "automations",
    uri: "docs://automations.md",
    description:
      "Automation trigger types, common patterns, and validation guidance.",
    text: `# Automations

## Purpose

Automations run agents in the background when a trigger fires. They are useful for recurring, event-driven, or webhook-driven workflows.

## Trigger types

### Schedule
- Use cron for recurring jobs.
- Good for daily summaries, regular syncs, and cleanup tasks.
- Validate the schedule before saving.

### Event
- Use when a connection or system emits a known event type.
- Good for reacting to new records, messages, or state changes.
- Be explicit about the event name and expected payload.

### Webhook
- Use when an external system should trigger the automation directly.
- Good for integrations that can POST to a URL.
- Confirm the caller and expected payload shape.

## Common patterns

### Daily report
1. Create or choose an agent that can gather the relevant data.
2. Create the automation.
3. Add a cron trigger.
4. Run a manual test if safe.

### Event-driven triage
1. Identify the event source and type.
2. Create the automation with the right agent.
3. Attach the event trigger.
4. Verify the agent can handle the event context.

### Webhook workflow
1. Create the automation.
2. Add a webhook trigger.
3. Share the webhook URL with the external system.
4. Validate with a controlled test call.

## Operational guidance

- The agent used by the automation must already have the required capabilities.
- Trigger edits can have delayed but significant effects, so validate carefully.
- Prefer focused automations over one automation doing many unrelated jobs.
`,
  },
];
