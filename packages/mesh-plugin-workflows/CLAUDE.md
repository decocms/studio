# Workflow Plugin - Architecture

## Overview

Event-driven workflow execution engine using the mesh event bus for external triggers and an event-driven step coordination model. Steps execute via fire-and-forget events, with atomic checkpointing and crash recovery on startup.

## Execution Model

The engine is a **pure DAG** (Directed Acyclic Graph). Steps run once, data flows forward, no cycles. Execution order is auto-determined from `@ref` dependencies — steps with no dependencies run in parallel, steps referencing `@stepName` wait for that step.

### Step Types

- **Tool call** (`{ toolName }`) — Invoke an MCP tool via proxy. Optional `transformCode` for post-processing. Default timeout 60s.
- **Code** (`{ code }`) — Run TypeScript in QuickJS sandbox. Format: `export default function(input) { ... }`. Default timeout 10s, 64MB memory limit.

### Data Flow

Steps wire data via `@ref` syntax:
- `@input.field` — workflow input
- `@stepName.field` — output from a completed step
- `@item` / `@item.field` — current forEach iteration item
- `@index` — current forEach iteration index
- Numeric array access: `@step.items.0.id`

Two resolution modes:
- **Complete @ref** (entire value is one reference) → type-preserving (returns the actual value, not stringified)
- **Interpolated @refs** (string contains multiple refs) → string interpolation: `"Hello @input.name, order @input.id"`

### forEach Loops

Steps can iterate over arrays with `forEach: { ref, concurrency? }`:
- `ref` — `@ref` that resolves to an array (e.g. `@fetch_users.data`)
- `concurrency` — max parallel iterations (default: 1, sequential)

Behavior:
- Positional output: `output[i]` corresponds to `input[i]`
- Failed iterations produce `null` at that position
- Empty arrays → immediate completion with `[]`
- Parent step collects all iteration results into an output array
- Crash recovery handles partially-completed iterations

Error handling defaults differ: regular steps default to `onError: "fail"`, forEach iterations default to `onError: "continue"`.

### Error Handling

Per-step `config.onError`:
- `"fail"` (default for regular steps) — abort the entire workflow on step failure
- `"continue"` (default for forEach iterations) — skip the error and continue with remaining steps

### Workflow Output

The workflow output is determined by terminal steps (steps not referenced by any other step):
- **Single terminal step** → its output becomes the workflow output
- **Multiple terminal steps** → output is `{ stepName: output, ... }` for all terminal steps

## Tool Step Details

When a tool step has `transformCode`:
1. Raw tool output is **checkpointed** to DB first (`raw_tool_output` column)
2. Transform code runs in QuickJS sandbox with the raw output as input
3. Final output (or transform error) is persisted as the step result

When a tool step has `outputSchema.properties`: output is filtered to only include keys declared in the schema (unless `transformCode` is also present).

## Timeout Strategy

The engine does **not** implement its own step-level or heartbeat-based timeout mechanisms. Instead, it relies on the inherent timeout guarantees of each step type:

- **Tool steps**: The MCP proxy `callTool()` accepts a `timeout` option (default 60s). If the tool call exceeds this, the proxy returns an error which is lifted to the step result.
- **Code steps**: The QuickJS sandbox uses `interruptAfterMs` (default 10s). Code that exceeds this is interrupted and returns an error.
- **Workflow-level deadline**: If `timeoutMs` is set on execution creation, a `deadline_at_epoch_ms` is computed. The orchestrator checks this deadline in `handleExecutionCreated` and `handleStepCompleted` — if exceeded, the execution is failed with a deadline error.

## Crash Recovery

- **On startup**: `recoverStuckExecutions()` finds all `running` executions, resolves incomplete step results, resets executions to `enqueued`, and re-publishes `workflow.execution.created` events.
- **Incomplete step resolution**:
  - Never-started steps (no `started_at`) → delete result (safe to retry)
  - Code steps (pure, no side effects) → delete result (safe to retry)
  - Tool steps (may have side effects) → mark as error with "interrupted by process restart"
- **Idempotent claims**: Both `claimExecution()` (execution-level) and `createStepResult()` (step-level, via `ON CONFLICT DO NOTHING`) are idempotent, so duplicate events are safely ignored.

## Event Types

Only three event types are used by the engine (via mesh event bus):

| Event | Purpose |
|-------|---------|
| `workflow.execution.created` | External trigger to start/resume an execution |
| `workflow.step.execute` | Dispatched by orchestrator to execute a step |
| `workflow.step.completed` | Notification that a step result has been persisted |

Note: The bindings schema (`packages/bindings/src/well-known/workflow.ts`) defines additional `EventTypeEnum` values (signal, timer, message, output, step_started, step_completed, workflow_started, workflow_completed) that are **not used** by the engine — they are schema-only for future use.

## MCP Tools (12 total)

### Workflow Collection (5 tools)
- `WORKFLOW_LIST` — List templates with pagination
- `WORKFLOW_GET` — Get single template with steps
- `WORKFLOW_CREATE` — Create new template
- `WORKFLOW_UPDATE` — Update existing template
- `WORKFLOW_DELETE` — Delete template

### Workflow Execution (7 tools)
- `WORKFLOW_EXECUTION_LIST` — List executions with filtering
- `WORKFLOW_EXECUTION_GET` — Get execution with step status
- `WORKFLOW_EXECUTION_CREATE` — Create execution from template
- `CANCEL_EXECUTION` — Cancel running execution
- `RESUME_EXECUTION` — Resume cancelled execution
- `WORKFLOW_EXECUTION_GET_STEP_RESULT` — Get step result
- `WORKFLOW_EXECUTION_GET_WORKFLOW` — Get workflow snapshot for execution

## Database Schema (4 tables)

- **workflow_collection** — Reusable workflow templates (steps as JSON, org-scoped)
- **workflow** — Immutable snapshot created per execution (steps + input frozen at creation time)
- **workflow_execution** — Execution state (status, input, output, error, deadline, timestamps)
- **workflow_execution_step_result** — Per-step results (composite PK: `execution_id` + `step_id`, includes `raw_tool_output` for transform checkpoints)

## Files

| File | Purpose |
|------|---------|
| `server/index.ts` | Plugin registration + startup recovery |
| `server/types.ts` | Type definitions, MeshContext interface |
| `server/engine/orchestrator.ts` | Core orchestration: claim, dispatch, complete, forEach |
| `server/engine/code-step.ts` | QuickJS sandbox execution (TS transpilation via sucrase) |
| `server/engine/tool-step.ts` | MCP proxy tool calls + transformCode |
| `server/engine/ref-resolver.ts` | `@ref` resolution for step inputs |
| `server/events/handler.ts` | Event routing + fire-and-forget dispatch |
| `server/storage/index.ts` | Storage factory |
| `server/storage/types.ts` | Kysely table interfaces |
| `server/storage/workflow-execution.ts` | DB operations for executions + step results |
| `server/storage/workflow-collection.ts` | DB operations for workflow templates |
| `server/tools/index.ts` | Tool exports |
| `server/tools/workflow-collection.ts` | 5 collection CRUD tools |
| `server/tools/workflow-execution.ts` | 7 execution management tools |
| `server/migrations/001-workflows.ts` | Database schema (4 tables) |
| `shared.ts` | Plugin constants (ID, description) |
| `client/index.tsx` | Client entry point |

### Schema (in `packages/bindings/src/well-known/workflow.ts`)
- `StepSchema`, `StepActionSchema`, `StepConfigSchema` — Step definitions
- `WorkflowSchema`, `WorkflowExecutionSchema` — Workflow and execution schemas
- DAG utilities: `computeStepLevels`, `groupStepsByLevel`, `buildDagEdges`, `validateNoCycles`, `getAllRefs`, `getStepDependencies`
- `WaitForSignalActionSchema` — Defined but **commented out** in `StepActionSchema` union

### Tests
- `server/engine/__tests__/orchestrator.test.ts` — Core orchestration (linear, parallel, forEach, errors, deadline)
- `server/engine/__tests__/ref-resolver.test.ts` — @ref parsing and resolution
- `server/engine/__tests__/crash-recovery.test.ts` — Recovery after process crash
- `server/engine/__tests__/durability.test.ts` — Event replay durability
- `server/engine/__tests__/stuck-prevention.test.ts` — Preventing stuck executions
- `server/engine/__tests__/stress.test.ts` — High-load scenarios
- `server/events/__tests__/handler.test.ts` — Event routing
- `server/storage/__tests__/workflow-execution.test.ts` — Storage operations

## Loops and Mutable State — Intentionally Not Supported

The workflow engine deliberately avoids full loops, shared mutable state, and cyclic execution (forEach is bounded iteration over a known array, not a general-purpose loop). For use cases that need unbounded iteration (LLM agent loops, polling, iterative refinement), the pattern is **recursive workflow invocation**: a step creates a new execution of the same workflow with updated input.

```
Execution 1: do_work → evaluate → not done → create Execution 2
Execution 2: do_work → evaluate → not done → create Execution 3
Execution 3: do_work → evaluate → done → return result
```

---

## Planned Features (Not Yet Implemented)

### Conditional Execution (`when`)

Add an optional `when` field to Step — a **structured condition object**, not code or expression strings:

```typescript
when?: {
  ref: string;        // @ref to resolve, e.g. "@validate.eligible"
  // At most one operator. If none specified: truthy check.
  eq?: unknown;       // step runs if resolved value equals this
  neq?: unknown;      // step runs if resolved value does NOT equal this
  gt?: number;        // step runs if resolved value > this
  lt?: number;        // step runs if resolved value < this
}
```

Evaluation happens at dispatch time: resolve the ref, apply the operator, skip if false (mark completed with `output: null`). The `when` ref is also a DAG dependency. Skipped steps cascade — downstream steps see `null` for skipped outputs.

UI presents this as visual branches (if/else diamond nodes) — users never see `when` JSON directly.

### Early Exit (`return` action)

A `{ return: true }` step action that exits the workflow early with success. Step's resolved input becomes workflow output. Combined with `when` for conditional early exit.

### Recording Mode

LLM-driven workflow building: start an empty execution → LLM calls tools naturally through the mesh proxy → each tool call is recorded as a workflow step → save as reusable template. The LLM uses `@ref` syntax in tool inputs, which the proxy resolves before forwarding.

### Implementation Checklist (when + return)

#### Schema changes (`packages/bindings/src/well-known/workflow.ts`)
- [ ] Add `StepConditionSchema` (ref, eq, neq, gt, lt)
- [ ] Add `when?: StepConditionSchema` to `StepSchema`
- [ ] Add `ReturnActionSchema` to `StepActionSchema` union
- [ ] Update `getStepDependencies` / `getAllRefs` to extract refs from `when.ref`

#### Engine changes (`server/engine/orchestrator.ts`)
- [ ] In `dispatchStep`: evaluate `when` condition before dispatching (skip if false)
- [ ] In `getReadySteps`: include `when` ref as a dependency for ordering
- [ ] In `handleStepExecute`: handle `return` action (passthrough input → output)
- [ ] In `handleStepCompleted`: detect `return` action → mark execution as `success`
- [ ] Skipped steps: mark completed with `output: null` + publish `step.completed`

#### No migration needed
- `output: null` already supported in step results
- `skipped` flag is optional metadata on the step result (no new column required)
