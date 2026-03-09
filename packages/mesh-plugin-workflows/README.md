# Workflows Plugin

Server + client plugin for MCP Mesh that provides workflow creation, management, and execution for platform end-users.

## Overview

An event-driven workflow execution engine built on the mesh event bus and PostgreSQL. Workflows are modeled as **DAGs** (Directed Acyclic Graph) — steps run once, data flows forward, no cycles. Execution order is auto-determined from `@ref` dependencies: steps with no dependencies run in parallel, steps referencing another step wait for it to complete.

## How It Works

### The Event-Driven Execution Loop

The engine coordinates entirely through the mesh event bus — there is no central loop, no polling, and no long-lived executor process. Each state transition is a discrete event, making the system naturally distributed and crash-recoverable.

The execution lifecycle uses four event types:

```
┌─────────────────────────┐
│ workflow.execution.created │  (or workflow.execution.resumed)
└────────────┬────────────┘
             │
             ▼
    ┌─────────────────┐
    │  claimExecution  │  Atomic: UPDATE ... WHERE status = 'enqueued'
    │  validate DAG    │  Reject cycles, empty steps
    │  resolve stale   │  Handle incomplete results from prior crash
    └────────┬────────┘
             │
             ▼
    ┌──────────────────┐
    │  advanceExecution │  Compute ready steps → fan out
    └────────┬─────────┘
             │  (for each ready step)
             ▼
  ┌──────────────────────┐
  │ workflow.step.execute  │
  └────────────┬───────────┘
               │
               ▼
      ┌─────────────────┐
      │  claim step      │  INSERT ... ON CONFLICT DO NOTHING
      │  resolve @refs   │
      │  run tool/code   │
      │  persist result  │
      └────────┬────────┘
               │
               ▼
  ┌────────────────────────┐
  │ workflow.step.completed  │
  └────────────┬─────────────┘
               │
               ▼
      ┌─────────────────────┐
      │  check errors        │  onError: "fail" → abort execution
      │  check forEach       │  collect iterations, dispatch next batch
      │  advanceExecution    │  all done? → mark success. more ready? → fan out
      └─────────────────────┘
```

Each event handler is fire-and-forget: the event bus delivers the event, the handler runs in the background, and the bus releases its processing lock immediately. This means the event bus worker is never blocked by workflow execution time.

### How It Uses the Database

Every state mutation goes through PostgreSQL (or PGlite) with careful use of atomic operations:

**Execution claiming** — `claimExecution()` uses `UPDATE ... SET status = 'running' WHERE id = ? AND status = 'enqueued'`. Only one worker wins the race; others see zero affected rows and bail. This is the entire distributed lock mechanism — no advisory locks, no external coordination.

**Step claiming** — `createStepResult()` uses `INSERT ... ON CONFLICT (execution_id, step_id) DO NOTHING` with `RETURNING`. If the row already exists, `RETURNING` yields nothing and the handler knows another worker got there first. Duplicate events are safely ignored.

**Conditional status transitions** — `updateExecution()` accepts `onlyIfStatus`, so concurrent completion handlers can't accidentally overwrite each other. The first to set `status = 'error'` or `status = 'success'` wins.

**Hot-path optimization** — `getExecutionContext()` runs the execution+workflow JOIN and step-result fetch in `Promise.all` to minimize round trips. It also projects only the columns the orchestrator needs (excludes `raw_tool_output` and `started_at_epoch_ms` to avoid transferring large payloads).

**Checkpoint-and-transform** — When a tool step has `transformCode`, the raw tool output is written to DB first (separate query), then the QuickJS transform runs outside any DB connection, then the final result is written. If the transform crashes, the raw output survives in `raw_tool_output` for debugging or retry.

### Crash Recovery

On startup, the plugin scans for executions stuck in `running` status (leftover from a previous process crash):

1. All `running` executions are atomically reset to `enqueued`
2. For each, a `workflow.execution.resumed` event is published
3. When the orchestrator re-claims, it inspects incomplete step results:
   - **Never-started steps** (no `started_at_epoch_ms`) — deleted, safe to retry
   - **Code steps** (pure computation) — deleted, safe to retry
   - **Tool steps** (may have side effects) — marked as errors with "interrupted by process restart"
4. The orchestrator then calls `advanceExecution()` which picks up where things left off

The `started_at_epoch_ms` column is the key signal: it's set right before a step begins actual execution (after claiming), so the recovery logic can distinguish "claimed but never started" from "was mid-execution."

## Step Types

### Tool Steps

Invoke any MCP tool available in the execution's Virtual MCP:

```typescript
{
  name: "fetch_user",
  action: { toolName: "GET_USER" },
  input: { email: "@input.user_email" }
}
```

The engine creates an MCP proxy to the Virtual MCP, calls the tool with resolved input, and returns `structuredContent ?? content` as the step output. Default timeout: 60s (configurable via `config.timeoutMs`).

**Output filtering** — If a step declares `outputSchema.properties`, only those keys are kept in the output (useful for stripping noisy API responses).

**Transform code** — Optional `transformCode` field runs a TypeScript function in QuickJS after the tool returns. The raw tool output is checkpointed to DB first, so the raw data survives even if the transform fails:

```typescript
{
  name: "fetch_and_transform",
  action: {
    toolName: "GET_USERS",
    transformCode: "export default function(input) { return input.data.map(u => u.email); }"
  }
}
```

### Code Steps

Run TypeScript in a QuickJS WASM sandbox. No network access, no file system — pure computation only:

```typescript
{
  name: "compute",
  action: {
    code: "export default function(input) { return { total: input.items.length }; }"
  },
  input: { items: "@fetch_items.data" }
}
```

- TypeScript is transpiled to JS via Sucrase before execution
- Default timeout: 10s (via `interruptAfterMs`)
- Memory limit: 64MB
- A fresh QuickJS runtime is created per execution (no shared state)
- `console.log/warn/error` are bridged to the host process (prefixed with `[SANDBOX]`)

## Data Flow

### The `@ref` System

Steps wire data via `@ref` syntax. The ref resolver runs at dispatch time, after all dependency steps have completed:

| Syntax | Resolves to |
|--------|-------------|
| `@input` | Entire workflow input |
| `@input.field` | Field from workflow input |
| `@stepName` | Entire output of a completed step |
| `@stepName.field` | Field from a step's output |
| `@stepName.items.0.id` | Numeric array indexing |
| `@stepName.items[0].id` | Bracket notation (normalized to dot) |
| `@item` / `@item.field` | Current forEach iteration item |
| `@index` | Current forEach iteration index |
| `@ctx.execution_id` | Current execution ID |

**Two resolution modes:**

- **Complete @ref** — if the entire value is a single `@ref` string, it returns the actual resolved value (preserves type: objects, arrays, numbers, booleans)
- **Interpolated @refs** — if the string contains multiple refs or text mixed with refs, they're interpolated as strings: `"Hello @input.name, order @input.id"` → `"Hello Alice, order 42"`

This distinction matters: `"@input.items"` resolves to the array `[1, 2, 3]`, while `"items: @input.items"` resolves to the string `"items: [1,2,3]"`.

### Dependency Resolution

The orchestrator extracts all `@ref` strings from a step's `input` (and `forEach.ref`), parses out step names, and builds a dependency set. A step is "ready" when all its dependency steps are in the completed set and it hasn't been claimed yet.

```
Steps: A (no deps), B (no deps), C (refs @A), D (refs @B, @C)

Round 1: A and B dispatched in parallel
Round 2: A completes → C dispatched. B completes → waiting for C.
Round 3: C completes → D dispatched.
Round 4: D completes → all terminal steps done → workflow success.
```

### forEach Loops

Steps can iterate over arrays:

```typescript
{
  name: "process_users",
  action: { toolName: "PROCESS_USER" },
  input: { user_id: "@item.id", name: "@item.name" },
  forEach: { ref: "@fetch_users.data", concurrency: 5 }
}
```

- Concurrency is windowed: the engine dispatches `concurrency` iterations initially, then refills slots as iterations complete
- Each iteration is a separate step claim (`stepName[0]`, `stepName[1]`, ...) — individually idempotent
- Positional output: `output[i]` corresponds to `input[i]`. Failed iterations produce `null`
- The parent step result is finalized only when all iterations complete
- Error handling differs: regular steps default to `onError: "fail"`, forEach iterations default to `onError: "continue"`

### Workflow Output

Determined by terminal steps (steps not referenced by any other step):
- **Single terminal step** — its output becomes the workflow output
- **Multiple terminal steps** — merged as `{ stepName: output, ... }`

## Timeout Strategy

The engine does **not** implement its own step-level timeout mechanism. It relies on the inherent timeouts of each execution context:

- **Tool steps**: MCP proxy `callTool()` timeout (default 60s, configurable via `config.timeoutMs`)
- **Code steps**: QuickJS `interruptAfterMs` (10s hard limit)
- **Workflow-level**: Optional `timeoutMs` on execution creation computes a `deadline_at_epoch_ms`. The orchestrator checks this deadline at claim time and after each step completion — if exceeded, the execution is failed immediately.

## Loops and Mutable State

Intentionally not supported. `forEach` is bounded iteration over a known array, not a general-purpose loop. For unbounded iteration (LLM agent loops, polling, iterative refinement), the pattern is **recursive workflow invocation**: a step creates a new execution of the same workflow with updated input.

## MCP Tools

### Workflow Templates (5 tools)

| Tool | Description |
|------|-------------|
| `COLLECTION_WORKFLOW_LIST` | List templates with pagination |
| `COLLECTION_WORKFLOW_GET` | Get a single template including its steps |
| `COLLECTION_WORKFLOW_CREATE` | Create a new workflow template |
| `COLLECTION_WORKFLOW_UPDATE` | Update an existing template |
| `COLLECTION_WORKFLOW_DELETE` | Delete a template |

### Workflow Execution (7 tools)

| Tool | Description |
|------|-------------|
| `COLLECTION_WORKFLOW_EXECUTION_LIST` | List executions with status filtering |
| `COLLECTION_WORKFLOW_EXECUTION_GET` | Get execution with per-step status breakdown |
| `COLLECTION_WORKFLOW_EXECUTION_CREATE` | Create an execution from a template (publishes to event bus) |
| `CANCEL_EXECUTION` | Cancel a running execution (in-flight steps finish, no new steps start) |
| `RESUME_EXECUTION` | Resume a cancelled/failed execution (preserves successful step outputs, retries failed) |
| `COLLECTION_WORKFLOW_EXECUTION_GET_STEP_RESULT` | Get a specific step's output/error |
| `WORKFLOW_EXECUTION_GET_WORKFLOW` | Get the immutable workflow snapshot for an execution |

### Creating Workflows via MCP

The `COLLECTION_WORKFLOW_CREATE` tool includes rich descriptions and examples in its schema, so LLMs can create workflows conversationally:

```json
{
  "title": "Fetch user and their orders",
  "steps": [
    {
      "name": "fetch_user",
      "action": { "toolName": "GET_USER" },
      "input": { "email": "@input.user_email" }
    },
    {
      "name": "fetch_orders",
      "action": { "toolName": "GET_USER_ORDERS" },
      "input": { "user_id": "@fetch_user.user.id" }
    }
  ]
}
```

The `virtual_mcp_id` defaults to the org-wide Decopilot agent if not specified. Executions can only call tools available in the designated Virtual MCP.

### Executing Workflows

`COLLECTION_WORKFLOW_EXECUTION_CREATE` creates an immutable snapshot of the template (so edits don't affect in-flight runs), then publishes a `workflow.execution.created` event to the bus. Supports `start_at_epoch_ms` for scheduled execution via the event bus `deliverAt` mechanism.

`RESUME_EXECUTION` clears failed/incomplete step results while preserving successful ones, resets the execution to `enqueued`, and re-publishes the creation event. The orchestrator picks it up, sees the existing successful results, and only dispatches the remaining steps.

## Database Schema

| Table | Purpose |
|-------|---------|
| `workflow_collection` | Reusable workflow templates (steps as JSON, org-scoped) |
| `workflow` | Immutable snapshot per execution (steps + input frozen at creation time) |
| `workflow_execution` | Execution lifecycle (status, input, output, error, deadline, timestamps) |
| `workflow_execution_step_result` | Per-step results (composite PK: `execution_id` + `step_id`, includes `raw_tool_output`) |

All tables are org-scoped via `organization_id` foreign keys with `ON DELETE CASCADE`.

## Runtime SDK (`packages/runtime/src/workflows.ts`)

MCP servers built with the Deco runtime can declare workflows as code. The runtime handles syncing them to the mesh, generating trigger tools, and managing Virtual MCPs — so a connection author never touches the workflow collection API directly.

### `createWorkflow()` — Fluent Builder

Type-safe, autocomplete-friendly API for defining workflows. Pass your tool definitions as the second argument and get full IDE support:

```typescript
import { createWorkflow, createTool } from "@decocms/runtime";

const GET_USERS = createTool({ id: "GET_USERS", /* ... */ });
const PROCESS_USER = createTool({ id: "PROCESS_USER", /* ... */ });

const myWorkflow = createWorkflow(
  { title: "Fetch and Process" },
  [GET_USERS, PROCESS_USER],       // ← enables toolName autocomplete
)
  .step("fetch_users", {
    action: { toolName: "GET_USERS" },  // ← autocomplete: "GET_USERS" | "PROCESS_USER"
  })
  .forEachItem("process_user", "@fetch_users", {
    //                          ^ autocomplete: @fetch_users, @input, @item...
    action: { toolName: "PROCESS_USER" },
    input: { userId: "@item.id" },
    concurrency: 5,
  })
  .build();
```

How the type magic works:
- **Step names are tracked** — each `.step("name", ...)` call widens the `TSteps` type parameter, so subsequent steps get `@name` in their `@ref` autocomplete
- **Tool input keys are inferred** — if a tool has `inputSchema: z.object({ email: z.string() })`, the step's `input` will suggest `email` as a key
- **Tool output schemas are auto-injected** — when a referenced tool has an `outputSchema`, the builder writes it into the step's `outputSchema` field so fingerprint changes propagate correctly
- **Code steps** work too: `{ action: { code: "export default function(input) { ... }" } }`

### `Workflow.sync()` — Automatic Sync to Mesh

Called during `ON_MCP_CONFIGURATION`, this syncs declared `WorkflowDefinition[]` to the mesh as `workflow_collection` entries. The sync is declarative and convergent:

1. **Fingerprint deduplication** — serializes the declared set and skips the remote round-trip when nothing changed. On error, the fingerprint is *not* stored, so the next call retries.
2. **Ownership by convention** — each workflow's ID is `${connectionId}::${slugified_title}`. The sync only touches workflows prefixed with the connection's ID, leaving other connections' workflows untouched.
3. **Upsert + orphan deletion** — creates new workflows, updates changed ones, and deletes workflows that are no longer declared (all in parallel).
4. **Per-connection mutex** — concurrent syncs for the same connection are chained (never interleaved), preventing LIST/CREATE/DELETE races.
5. **Default Virtual MCP** — if any workflow omits `virtual_mcp_id`, the runtime lazily resolves (or creates) a "Workflows Agent (`connectionId`)" Virtual MCP that routes to the declaring connection's tools.

### `Workflow.createExecution()` — Programmatic Execution

Trigger a workflow execution from code (useful for auto-generated trigger tools):

```typescript
const executionId = await Workflow.createExecution(meshUrl, token, {
  workflow_collection_id: "conn_abc::fetch-and-process",
  input: { user_email: "alice@example.com" },
  // virtual_mcp_id: "...",     // optional override
  // start_at_epoch_ms: ...,    // optional scheduled start
});
```

### Auto-Generated Trigger Tools

Each declared workflow automatically gets a trigger tool named `START_WORKFLOW_<TITLE_SLUG>` (e.g. `"Fetch and Process"` → `START_WORKFLOW_FETCH_AND_PROCESS`). The `toolId` field on `WorkflowDefinition` lets you override this name. These tools are registered in the connection's tool list and call `Workflow.createExecution()` under the hood.

## Plugin Structure

```
mesh-plugin-workflows/
├── shared.ts                    # Plugin constants (ID, description)
├── server/
│   ├── index.ts                 # Plugin registration + startup recovery
│   ├── types.ts                 # Type definitions, MeshContext interface
│   ├── engine/
│   │   ├── orchestrator.ts      # Core: claim, dispatch, complete, forEach
│   │   ├── code-step.ts         # QuickJS sandbox execution
│   │   ├── tool-step.ts         # MCP proxy tool calls + transformCode
│   │   └── ref-resolver.ts      # @ref resolution
│   ├── events/
│   │   └── handler.ts           # Event routing + fire-and-forget dispatch
│   ├── storage/
│   │   ├── index.ts             # Storage factory
│   │   ├── types.ts             # Kysely table interfaces
│   │   ├── workflow-collection.ts
│   │   └── workflow-execution.ts
│   ├── tools/
│   │   ├── index.ts             # Tool exports
│   │   ├── workflow-collection.ts  # 5 CRUD tools
│   │   └── workflow-execution.ts   # 7 execution tools
│   └── migrations/
│       ├── index.ts
│       ├── 001-workflows.ts     # Database schema (4 tables)
│       └── 002-execution-list-index.ts
└── client/
    ├── index.tsx                # Client plugin entry
    └── components/
        ├── plugin-header.tsx
        └── plugin-empty-state.tsx
```

## Tests

```bash
bun test --cwd packages/mesh-plugin-workflows
```

| Suite | Coverage |
|-------|----------|
| `orchestrator.test.ts` | Linear, parallel, forEach, errors, deadline |
| `ref-resolver.test.ts` | @ref parsing, resolution, interpolation |
| `crash-recovery.test.ts` | Recovery after process crash |
| `durability.test.ts` | Event replay durability |
| `stuck-prevention.test.ts` | Preventing stuck executions |
| `stress.test.ts` | High-load scenarios |
| `handler.test.ts` | Event routing |
| `workflow-execution.test.ts` | Storage operations |

## License

See [LICENSE.md](../../LICENSE.md) in the repository root.
