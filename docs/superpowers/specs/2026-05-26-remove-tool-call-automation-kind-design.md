# Remove Tool-Call Automation Kind

**Status:** Approved
**Date:** 2026-05-26

## Goal

Simplify the automations subsystem by removing the `kind = "tool_call"` execution mode. After this change, every automation runs through the agent path — there is no longer a discriminator on how an automation executes when its trigger fires.

## Motivation

Migration `078-automation-tool-call-kind` introduced a second execution mode for automations: when a trigger fires, instead of running an agent thread, the automation invokes a fixed MCP tool with fixed arguments. This added a `kind` discriminator and three conditional columns (`connection_id`, `tool_name`, `tool_input`), plus a parallel runtime branch and a sizeable UI surface (`tool-call-config-fields.tsx`, dropdown menus, per-row icon switching, task-row metadata detection).

The feature is recent (078 of 081 migrations) and has not been adopted. The added flexibility is not worth the ongoing maintenance cost: every storage type, every UI surface that lists or edits an automation, and the workflow runtime all carry a branch for it. Removing it shrinks `dbos-workflow.ts`, deletes a UI component, and lets `automation-detail.tsx` stop branching on kind.

## Non-Goals

- Triggers (webhooks, schedules, events) are out of scope. Only the execution mode changes; triggers continue to fire automations the same way.
- Historical `tool_call_run` thread metadata in the threads table is left in place. The UI just stops special-casing it.
- No replacement is being designed for the deterministic-invocation use case. If it comes back later, it will be redesigned from scratch.

## Approach

Single PR, forward-only:

1. Add migration `082-remove-automation-tool-call-kind` that deletes all `kind='tool_call'` rows, drops the three CHECK constraints, drops the four conditional columns, and restores `NOT NULL` on `virtual_mcp_id`.
2. Delete every `tool_call` branch across storage, runtime, tools, UI, and tests.

The decision to drop tool-call rows without preservation reflects that the feature has not shipped to users.

## Changes by File

### Database

**`apps/mesh/migrations/082-remove-automation-tool-call-kind.ts`** (new)

- `up()`: drop `chk_automation_tool_call_fields`, `chk_automation_agent_fields`, `chk_automation_kind`; `DELETE FROM automations WHERE kind = 'tool_call'`; restore `NOT NULL` on `virtual_mcp_id`; drop columns `tool_input`, `tool_name`, `connection_id`, `kind`.
- `down()`: mirror of `078.up()` — re-adds the four columns nullable, makes `virtual_mcp_id` nullable, re-adds the three CHECK constraints. Data is not restored. The `down()` is structurally reversible only.

### Storage

**`apps/mesh/src/storage/types.ts`**

- Remove the `AutomationKind` type alias.
- Remove `kind`, `connection_id`, `tool_name`, `tool_input` from `AutomationTable` and `Automation`.
- `virtual_mcp_id` becomes non-nullable on both.

**`apps/mesh/src/storage/automations.ts`**

- Remove `kind` and tool-call fields from `CreateAutomationInput` and `UpdateAutomationInput`.
- Delete `createToolCallRunThread()`.
- Simplify `automationFromDbRow()` to construct an agent automation unconditionally.
- Remove `kind`, `connection_id`, `tool_name`, `tool_input` from `TRIGGER_JOIN_AUTOMATION_COLUMNS`.

### Runtime

**`apps/mesh/src/automations/dbos-workflow.ts`**

- Delete `createToolCallRunThreadStep`, `invokeFixedToolStep`, `persistToolCallResultStep`, `runToolCallFire`.
- `fireAutomationWorkflowFn` no longer branches on `automation.kind` — it always runs the agent path.
- `prepareFireStep` no longer skips model resolution for tool-call automations.

### MCP Tools

**`apps/mesh/src/tools/automations/create.ts`**

- Drop the `kind` field from the input schema and the conditional validation block for agent vs tool_call.
- Analytics call drops `kind`.

**`apps/mesh/src/tools/automations/update.ts`**

- Drop tool-call field handling (`connection_id`, `tool_name`, `tool_input`).

**`apps/mesh/src/tools/automations/get.ts`** and **`list.ts`**

- Drop `kind` from output schemas. Drop any tool-call fields exposed in `list`.

### Frontend (`apps/mesh/src/web`)

**`views/automations/automations-list.tsx`**

- Replace the dropdown ("Agent automation" / "Tool-call automation") with a single "New automation" button that calls the agent creation path.
- Delete `handleNewToolCall` and the `automation_new_tool_call_clicked` analytics event.

**`hooks/use-automations.ts`**

- Delete `buildDefaultToolCallAutomationInput()`.
- Drop `kind` from `AutomationListItem` and `AutomationDetail`.
- Drop any tool-call fields from those interfaces.

**`views/automations/automation-detail.tsx`**

- Strip every `isToolCall` / `kind === "tool_call"` branch. The autosave handler, run handler, and rendering all collapse to the agent path.
- Drop the tool-call-specific analytics dimension.

**`views/automations/automation-list-row.tsx`**

- Drop `isToolCall` branching for icon and label. Always render the agent avatar and the agent label.

**`layouts/main-panel-tabs/automation-tab.tsx`**

- Drop the `isToolCall` branch.

**`layouts/tasks-panel/task-row.tsx`** and **`layouts/tasks-panel/mcp-avatar.tsx`**

- Drop the `metadata.kind === "tool_call_run"` detection. Threads always render as agent threads.

**DELETE: `views/automations/tool-call-config-fields.tsx`** entirely (component + `ToolCallConfigValue` type).

### Tests

**`apps/mesh/src/automations/automation-event-dispatcher.test.ts`**

- Drop the `kind` override in `makeAutomation()`.

Grep `kind: "tool_call"` and `tool_call_run` across the repo and remove remaining references.

## Risks

- **Stale references after refactor.** The kind discriminator is touched in many UI files; a missed branch could leave dead code that renders nothing or a never-reached conditional. Mitigation: `bun run check` (typecheck) and `bun run lint` will catch most; a final repo-wide grep for `tool_call` and `AutomationKind` after editing closes the gap.
- **Migration ordering.** `082` must apply cleanly after `081`. Since `081` is `async-research-jobs-result-content` and is unrelated to automations, no interaction is expected.
- **Existing `tool_call_run` thread metadata.** Some thread rows in production-like environments may carry `metadata.kind = 'tool_call_run'`. After the UI stops special-casing this, those threads will render as ordinary agent threads. This is acceptable — they remain readable, just without the dedicated icon.

## Verification

- `bun run check` passes (no remaining references to `AutomationKind`, tool-call fields, or `kind === "tool_call"`).
- `bun run lint` passes.
- `bun test` passes; updated `automation-event-dispatcher.test.ts` still covers the agent path.
- Manual: create an automation through the UI, confirm only one "New automation" entry point exists; confirm the detail page no longer surfaces tool-call fields; confirm an existing agent automation still fires when triggered.
- Migration: apply `082` against a local DB with at least one synthetic `kind='tool_call'` row, confirm the row is deleted and the columns are gone.
