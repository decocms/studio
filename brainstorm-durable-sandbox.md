# Durable Sandbox Execution: Brainstorm

> Applying workflow engine patterns to make virtual tool / code execution sandbox calls **checkpointable, durable, and observable** — with node-based UI visualization.

---

## The Gap Today

| Concern | Workflow Engine | Sandbox (Virtual Tools / Code Execution) |
|---------|----------------|------------------------------------------|
| Durability | Full — every step persisted, crash-recoverable | None — in-memory, fail-fast |
| Checkpointing | Raw tool output saved before transform | Nothing saved mid-execution |
| Observability | Step-level status (running/completed/error) | Only final result returned |
| UI | DAG visualization with step statuses | Monaco JSON viewer of final output |
| Resume | Re-enqueue stuck executions on startup | Not possible |
| Tool call tracing | Each tool call = a step with its own result row | Tool calls invisible inside sandbox |

The workflow engine already solved the hard problems: idempotent claims, crash recovery, DAG scheduling, per-step persistence, and UI-friendly node representation. The sandbox is a black box that swallows all intermediate state.

---

## What We Want

1. **Every tool call inside a sandbox execution becomes a visible, persisted node** — not just the final return value.
2. **If the process crashes mid-execution, we can resume** from the last completed tool call instead of replaying everything.
3. **The UI can render a live execution trace** as a graph or timeline — showing which tools were called, in what order, with what inputs/outputs.
4. **Backwards compatible** — existing virtual tools and `GATEWAY_RUN_CODE` keep working without changes.

---

## Approach 1: Shippable Now — Instrumented Sandbox with Trace Logging

### Idea

Don't change the execution model. Instead, **intercept tool calls** inside the sandbox to log them as trace events. No durability, no resume — just observability.

### How It Works

1. Wrap each `ToolHandler` passed into `runCode()` with an interceptor:

```typescript
function instrumentToolHandler(
  name: string,
  handler: ToolHandler,
  trace: TraceEvent[],
): ToolHandler {
  return async (args) => {
    const event: TraceEvent = {
      type: "tool_call",
      name,
      input: args,
      startedAt: Date.now(),
    };
    trace.push(event);
    try {
      const result = await handler(args);
      event.output = result;
      event.completedAt = Date.now();
      return result;
    } catch (err) {
      event.error = err instanceof Error ? err.message : String(err);
      event.completedAt = Date.now();
      throw err;
    }
  };
}
```

2. Return the trace alongside the result:

```typescript
interface RunCodeResult {
  returnValue?: unknown;
  error?: string;
  consoleLogs: SandboxLog[];
  trace: TraceEvent[];  // NEW
}
```

3. The UI renders the trace as a timeline or mini-DAG.

### Assumptions

- Tool calls inside sandbox code are sequential (QuickJS is single-threaded; even `Promise.all` resolves one at a time through the job pump).
- We don't need to persist the trace — it's ephemeral, attached to the response.
- The trace is small enough to fit in memory and in the response payload.

### Tradeoffs

| Pro | Con |
|-----|-----|
| Zero schema changes | No durability — crash = lost |
| Zero migration | No resume capability |
| Trivial to implement (~50 LOC) | Trace only available after completion |
| Backwards compatible | Can't show live progress (no streaming of trace) |
| Immediately useful for debugging | |

### Risks

- Large traces (many tool calls) could bloat the response. Mitigation: cap trace size, truncate large inputs/outputs.
- No live visibility — you see the trace only after the sandbox finishes or errors.

---

## Approach 2: Architecturally Refined — Durable Execution with Replay

### Idea

Treat the sandbox execution as a **lightweight workflow** where each tool call is an implicit step. Persist tool call results as they happen. On crash, replay the execution using cached results instead of re-calling tools.

This is the "durable execution" pattern (à la Temporal, Restate, or the workflow engine's own `checkpointAndTransform`).

### How It Works

#### 2a. Execution Journal

Each sandbox execution gets a **journal** — an ordered log of tool call results:

```typescript
interface JournalEntry {
  seq: number;          // monotonic sequence within this execution
  tool_name: string;
  input: unknown;
  output?: unknown;
  error?: string;
  started_at_epoch_ms: number;
  completed_at_epoch_ms?: number;
}
```

The journal is stored in a DB table (or as rows in the existing `workflow_execution_step_result` table if we model sandbox runs as single-step workflows).

#### 2b. Replay-Aware Tool Handler

```typescript
function durableToolHandler(
  name: string,
  handler: ToolHandler,
  journal: Journal,
): ToolHandler {
  return async (args) => {
    const entry = journal.nextEntry();

    // REPLAY: if journal has a completed entry at this sequence, return it
    if (entry?.completed_at_epoch_ms && entry.tool_name === name) {
      return entry.output;
    }

    // LIVE: execute the real handler and persist
    const result = await handler(args);
    await journal.append({
      tool_name: name,
      input: args,
      output: result,
      started_at_epoch_ms: Date.now(),
      completed_at_epoch_ms: Date.now(),
    });
    return result;
  };
}
```

#### 2c. Crash Recovery

On startup (or on retry), load the journal for the execution. The replay-aware handler skips already-completed calls and resumes from where it left off. The user code re-executes from the top, but tool calls that already succeeded return cached results instantly.

#### 2d. UI Nodes

Each journal entry becomes a node in the execution graph:

```
[Start] → [tool_1: fetch_users] → [tool_2: transform_data] → [tool_3: save_results] → [End]
```

The UI can show:
- Live progress (entries appear as they're persisted)
- Input/output inspection per node
- Error highlighting
- Duration per tool call
- Total execution timeline

#### 2e. Storage Options

**Option A: New table**

```sql
CREATE TABLE sandbox_execution (
  id TEXT PRIMARY KEY,
  virtual_mcp_id TEXT,
  code TEXT,
  args TEXT,         -- JSON
  status TEXT,       -- enqueued | running | success | error
  output TEXT,       -- JSON
  error TEXT,
  created_at_epoch_ms INTEGER,
  completed_at_epoch_ms INTEGER
);

CREATE TABLE sandbox_execution_journal (
  execution_id TEXT,
  seq INTEGER,
  tool_name TEXT,
  input TEXT,        -- JSON
  output TEXT,       -- JSON
  error TEXT,
  started_at_epoch_ms INTEGER,
  completed_at_epoch_ms INTEGER,
  PRIMARY KEY (execution_id, seq)
);
```

**Option B: Reuse workflow engine**

Model each sandbox execution as a single-step workflow where the "step" is the code execution. Tool calls within the sandbox become sub-step journal entries. This reuses existing storage, crash recovery, and UI infrastructure.

**Option C: Piggyback on workflow step results**

Create a workflow execution with auto-generated steps (one per tool call). This is the most integrated but requires knowing the tool call graph upfront — which we don't, since the code is imperative.

### Assumptions

- Tool calls are deterministic enough that replaying the same code with cached tool results produces the same behavior (the standard durable execution assumption).
- The sequence of tool calls is deterministic for a given input (no randomness in control flow that changes which tools get called).
- Journal entries are small enough to store in the DB without performance issues.

### Tradeoffs

| Pro | Con |
|-----|-----|
| Full durability — survives crashes | Requires new DB table + migration |
| Resume from last checkpoint | Replay assumption may not hold for all code |
| Live UI progress | More complex implementation (~300-500 LOC) |
| Reusable for any sandbox execution | Slight latency overhead per tool call (DB write) |
| Natural node representation for UI | Need to handle non-deterministic code gracefully |
| Can integrate with existing workflow UI | |

### Risks

- **Non-deterministic code**: If user code uses `Math.random()` or time-dependent logic to decide which tools to call, replay may diverge. Mitigation: detect divergence (tool name mismatch at replay position) and fail with a clear error.
- **Side-effectful tool calls**: Replaying means we skip the tool call, but the tool may have already executed partially. Same risk as the workflow engine — we accept it and document the at-most-once guarantee for tool calls during replay.
- **Journal bloat**: Long-running sandbox executions with many tool calls could create large journals. Mitigation: configurable max journal size, TTL-based cleanup.

---

## Approach 3: Hybrid — Trace Now, Journal Later

### Idea

Ship Approach 1 (instrumented trace) immediately. Design the `TraceEvent` type to be forward-compatible with the journal schema. When we're ready, add persistence behind a feature flag.

### Phase 1 (Now)

- Instrument tool handlers with trace collection
- Return trace in `RunCodeResult`
- UI renders trace as timeline/mini-graph
- No DB changes

### Phase 2 (Later)

- Add `sandbox_execution` + `sandbox_execution_journal` tables
- Persist trace events as journal entries during execution
- Add replay logic for crash recovery
- UI switches from response-embedded trace to DB-backed live view

### Phase 3 (Future)

- Unify with workflow engine: sandbox executions can be steps in workflows, and workflows can contain sandbox steps that are themselves durable
- Recording mode: capture sandbox traces as workflow templates
- Streaming trace updates via SSE/WebSocket

---

## Approach 4: Sandbox-as-Workflow — Full Convergence

### Idea

Instead of making the sandbox durable independently, **compile sandbox code into a workflow DAG** at execution time. Each `await tools.X(args)` becomes a tool step. The workflow engine handles everything else.

### How It Would Work

1. **Static analysis** (or runtime recording) extracts tool calls from the code
2. Each tool call becomes a workflow step with `@ref` wiring
3. Code between tool calls becomes code steps
4. The resulting DAG is executed by the existing workflow engine
5. Full durability, crash recovery, and UI visualization for free

### Why This Is Hard

- Imperative code doesn't map cleanly to a DAG. Conditionals (`if/else`), loops, and dynamic tool selection make static analysis unreliable.
- Runtime recording (execute once, capture the trace, replay as workflow) only works for deterministic code.
- The workflow engine expects steps to be declared upfront, not discovered during execution.

### When This Makes Sense

- For **recording mode** (already planned in the workflow plugin): let the LLM run code, capture the tool call sequence, save as a workflow template.
- For **simple orchestration code** that is essentially "call A, then B with A's result, then C" — this is already what workflows do, just with a code syntax instead of JSON.

### Tradeoffs

| Pro | Con |
|-----|-----|
| Full reuse of workflow infrastructure | Impedance mismatch: imperative code ≠ DAG |
| Zero new durability code | Static analysis is fragile |
| Unified UI for workflows and sandbox | Loses the flexibility of imperative code |
| Recording mode alignment | Complex implementation |

---

## Comparison Matrix

| Dimension | Approach 1: Trace | Approach 2: Journal | Approach 3: Hybrid | Approach 4: Compile |
|-----------|-------------------|--------------------|--------------------|---------------------|
| **Effort** | ~1 day | ~1 week | ~1 day + ~1 week | ~2-3 weeks |
| **Durability** | None | Full | Phased | Full |
| **UI nodes** | Post-hoc trace | Live journal | Phased | Workflow DAG |
| **Resume** | No | Yes | Phased | Yes |
| **Schema changes** | None | New tables | Phased | Reuse workflow tables |
| **Risk** | Low | Medium | Low → Medium | High |
| **Backwards compat** | Full | Full | Full | Breaking for complex code |

---

## Recommendation

**Ship Approach 3 (Hybrid).**

Phase 1 is low-risk, immediately useful, and validates the UI design. The trace type is designed to be forward-compatible with the journal schema, so Phase 2 is a natural extension rather than a rewrite.

Approach 4 (compile to workflow) is interesting for recording mode but shouldn't block the core durability story. It's a separate feature that can coexist with the journal approach.

---

## Evolution Path

```
Phase 1: Instrumented Trace (Approach 1)
  ├── Wrap tool handlers with trace interceptors
  ├── Return trace in RunCodeResult
  ├── UI: timeline view of tool calls
  └── ~1 day of work

Phase 2: Durable Journal (Approach 2)
  ├── Add sandbox_execution + journal tables
  ├── Persist trace events during execution
  ├── Replay-aware tool handlers
  ├── Crash recovery on startup
  ├── UI: live progress view
  └── ~1 week of work

Phase 3: Convergence (Approach 4, selective)
  ├── Recording mode: capture traces as workflow templates
  ├── Sandbox steps in workflows use journal for durability
  ├── Unified execution viewer in UI
  └── ~2 weeks of work
```

---

## Key Patterns to Reuse from Workflow Engine

| Pattern | Where It Lives | How to Reuse |
|---------|---------------|--------------|
| Idempotent claims | `orchestrator.ts` — `createStepResult()` with `ON CONFLICT DO NOTHING` | Same pattern for journal entries |
| Checkpoint before transform | `tool-step.ts` — `checkpointAndTransform()` | Persist raw tool output before user code continues |
| Crash recovery | `orchestrator.ts` — `resolveIncompleteStepResults()` | Load journal, replay completed entries, resume |
| Step status tracking | `buildOrchestrationSets()` | Journal entries have the same started/completed/error lifecycle |
| DAG edges for UI | `buildDagEdges()` from bindings | Sequential tool calls = linear chain; parallel = fan-out |
| Event-driven dispatch | Event bus publish/subscribe | Could use events for live trace updates to UI |
| Fire-and-forget execution | `routeEvent()` in handler.ts | Sandbox execution can be async with event notification on completion |

---

## Open Questions

1. **Should sandbox executions be first-class entities?** Or just ephemeral traces attached to tool call results? First-class means they get IDs, can be listed, inspected, and retried. Ephemeral means simpler but less powerful.

2. **How do we handle `Promise.all` in sandbox code?** QuickJS is single-threaded, so concurrent tool calls are actually sequential. But the user intent is parallelism. Should we detect this pattern and create parallel nodes in the trace?

3. **Should the journal be opt-in?** Some sandbox executions are trivial (no tool calls, just data transformation). Adding journal overhead for these is wasteful. Could be controlled by a flag or auto-detected (only journal if tools are provided).

4. **What's the retention policy for journals?** Workflow executions are kept indefinitely. Sandbox traces might be more ephemeral. Need a TTL or max-count policy.

5. **Can we stream trace updates?** The current sandbox runs synchronously from the caller's perspective. To show live progress, we'd need either SSE streaming of trace events or a polling endpoint. The event bus could help here.
