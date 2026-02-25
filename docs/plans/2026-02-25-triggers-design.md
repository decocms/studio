# Triggers Design

**Date**: 2026-02-25
**Status**: Approved

## Overview

Triggers are a simple automation primitive: "When X happens, do Y." They let users schedule recurring actions (cron) or react to events — without building agents or writing code.

Two action types:
1. **Call a tool** on a specific connection (e.g., `SEND_SLACK_MESSAGE` on the Slack MCP)
2. **Run an agent** with a prompt (e.g., "Check the latest emails and summarize for the team")

## Data Model

New `triggers` table:

| Column | Type | Description |
|--------|------|-------------|
| id | text, PK | Prefixed `trig_` |
| organization_id | text, FK | Organization scope |
| title | text, nullable | Optional user-friendly name |
| enabled | boolean, default true | Active or paused |
| trigger_type | text | `"cron"` or `"event"` |
| cron_expression | text, nullable | Cron expression (when trigger_type=cron) |
| event_type | text, nullable | Event type to listen for (when trigger_type=event) |
| event_filter | text, nullable | Optional JSONPath filter on event data |
| action_type | text | `"tool_call"` or `"agent_prompt"` |
| connection_id | text, nullable | For tool_call: which connection |
| tool_name | text, nullable | For tool_call: which tool |
| tool_arguments | text, nullable | For tool_call: JSON arguments |
| agent_id | text, nullable | For agent_prompt: which Virtual MCP |
| agent_prompt | text, nullable | For agent_prompt: the prompt text |
| event_id | text, nullable | Internal: ref to cron event in events table |
| subscription_id | text, nullable | Internal: ref to event subscription |
| last_run_at | text, nullable | ISO timestamp of last execution |
| last_run_status | text, nullable | `"success"` or `"failed"` |
| last_run_error | text, nullable | Error message from last failure |
| created_at | timestamp | |
| updated_at | timestamp | |
| created_by | text | |
| updated_by | text, nullable | |

Indexes:
- `idx_triggers_org`: (organization_id) — list triggers by org
- `idx_triggers_org_enabled`: (organization_id, enabled) — active triggers
- `idx_triggers_event_id`: (event_id) — lookup by event bus reference
- `idx_triggers_subscription_id`: (subscription_id) — lookup by subscription reference

## Backend Architecture

### Approach: Thin Layer on Event Bus

Triggers reuse the existing event bus infrastructure. No new worker or scheduler needed.

#### Cron Triggers

1. User creates trigger with `trigger_type=cron`, `cron_expression="0 9 * * 1-5"`
2. System publishes a cron event via event bus: `EVENT_PUBLISH({ type: "trigger.fire", cron: "0 9 * * 1-5", data: { triggerId } })`
3. System subscribes an internal executor to `trigger.fire` events
4. When the event bus fires the cron event, the executor receives it via `ON_EVENTS`
5. Executor looks up the trigger, executes the action (tool call or agent prompt)
6. Updates `last_run_at`, `last_run_status`, `last_run_error` on the trigger record

#### Event Triggers

1. User creates trigger with `trigger_type=event`, `event_type="order.created"`
2. System subscribes the internal executor to `order.created` events
3. When any connection publishes `order.created`, the executor receives it
4. Executor looks up the trigger by subscription_id, executes the action
5. Passes the event data to the tool arguments or agent prompt context

#### Action Execution

**Tool Call**: Uses MCP proxy to call the specified tool on the connection:
- `POST /mcp/:connectionId/call-tool/:toolName` with the configured arguments
- Or programmatically via `clientFromConnection()` + `callTool()`

**Agent Prompt**: Uses the Decopilot stream API:
- Creates a new thread (task) for execution tracking
- Sends the configured prompt to the specified Virtual MCP
- Thread captures the full conversation (agent responses, tool calls made)

#### Internal Executor

A special handler registered on the event bus that:
1. Receives `trigger.fire` events (for cron) or subscribed event types (for event triggers)
2. Looks up the trigger record
3. Checks `enabled` flag (skip if paused)
4. Executes the action
5. Updates trigger metadata (last_run_at, last_run_status)
6. Optionally creates a Task (thread) for execution history

### MCP Tools

New tools following the `defineTool()` pattern:

| Tool | Description |
|------|-------------|
| TRIGGER_CREATE | Create a new trigger (cron or event) |
| TRIGGER_LIST | List triggers for the organization |
| TRIGGER_GET | Get trigger details by ID |
| TRIGGER_UPDATE | Update trigger config (including enable/disable) |
| TRIGGER_DELETE | Delete a trigger and clean up event bus references |

All tools enforce auth and org scoping via `ctx.access.check()`.

### Cleanup

When a trigger is deleted:
- If cron: cancel the cron event via `EVENT_CANCEL`
- If event: unsubscribe via `EVENT_UNSUBSCRIBE`
- Delete the trigger record

When a trigger is disabled:
- Don't cancel/unsubscribe — just skip execution in the executor (check `enabled` flag)
- This preserves the event bus state for quick re-enable

## UI Design

### Navigation

Triggers appears in the sidebar under the **Build** group:
- Agents
- Connections
- **Triggers** ← new
- Store

Uses a clock/zap icon from @untitledui/icons.

### List Page (`/$org/org-admin/triggers`)

Each trigger renders as a card-row that reads as a sentence:

```
┌─────────────────────────────────────────────────────────────┐
│  ⏰  Every weekday at 9:00 AM                    [on/off]  │
│      → Run agent "Email Summarizer"                         │
│      Last run: 2h ago ✓  ·  Next: tomorrow 9:00 AM         │
└─────────────────────────────────────────────────────────────┘
```

Key elements:
- **Icon**: Clock for cron, lightning bolt for event
- **Primary line**: Human-readable "when" (cron translated to English, or event type)
- **Secondary line**: Arrow + action description
- **Metadata line**: Last run (relative time + status dot) · Next run (for cron)
- **Toggle switch**: Enable/disable inline, no extra clicks
- **Click**: Opens detail page

Standard search + sort controls. Table view also available via view toggle.

Empty state: "No triggers yet. Create your first automation."

### Create Flow

A dialog with "When…Then…" sentence structure:

**"When" section**:
- Two pill toggles: Schedule | Event
- Schedule: cron expression input + live human-readable preview ("Runs next: Tomorrow at 9:00 AM")
- Event: event type input + optional filter

**"Then" section**:
- Two pill toggles: Call a Tool | Run an Agent
- Call a Tool: connection selector → tool selector → optional JSON arguments
- Run an Agent: agent selector → prompt textarea

**Optional**: Name field at the top (auto-generates from the when+then if left empty)

### Detail Page (`/$org/org-admin/triggers/$triggerId`)

Same "When…Then…" layout as create, but editable. Below the config:
- **Recent Executions**: Links to Tasks (threads) created by this trigger
- **Quick stats**: Total runs, success rate, last failure

### Animations

| Element | Animation | Easing | Duration |
|---------|-----------|--------|----------|
| Dialog enter | scale(0.97→1) + opacity(0→1) | ease-out-quint | 200ms |
| Dialog exit | scale(1→0.97) + opacity(1→0) | ease-out | 150ms |
| When/Then sections | staggered fadeIn + translateY(4→0) | ease-out | 150ms, 50ms stagger |
| Pill toggle background | slide to selected pill | ease-out | 150ms |
| Form fields appear (below pill) | opacity(0→1) + translateY(4→0) | ease-out | 150ms |
| On/off switch | standard switch animation | ease-in-out | 150ms |
| Card-row hover | subtle background tint | ease | 150ms |
| Status dot pulse (running) | opacity pulse | ease-in-out | 2000ms, infinite |

All animations respect `prefers-reduced-motion: reduce` → disabled.

## Migration

New Kysely migration: `0XX-triggers.ts` (next available number)

Creates the `triggers` table with organization cascade delete.

## File Structure

```
apps/mesh/
├── migrations/0XX-triggers.ts
├── src/
│   ├── storage/triggers.ts          # Database operations
│   ├── tools/triggers/
│   │   ├── index.ts                 # Tool exports
│   │   ├── create.ts                # TRIGGER_CREATE
│   │   ├── list.ts                  # TRIGGER_LIST
│   │   ├── get.ts                   # TRIGGER_GET
│   │   ├── update.ts                # TRIGGER_UPDATE
│   │   └── delete.ts                # TRIGGER_DELETE
│   ├── triggers/
│   │   └── executor.ts              # Internal trigger executor
│   └── web/
│       ├── routes/orgs/triggers.tsx        # List page
│       ├── routes/orgs/trigger-detail.tsx  # Detail page
│       └── components/triggers/
│           ├── create-trigger-dialog.tsx   # Create dialog
│           ├── trigger-card.tsx            # Card-row component
│           ├── cron-input.tsx              # Cron expression input with preview
│           ├── tool-action-form.tsx        # Tool call configuration
│           └── agent-action-form.tsx       # Agent prompt configuration
```
