# Just-in-Time Connection Gate for Agents & Subagents — Design

**Date:** 2026-05-31
**Status:** Approved (brainstorm) — pending spec review
**Topic:** Replace the upfront slot gate with a single runtime "connect card" mechanism shared by agent (parent) and subagent (subtask) flows.

## Problem

Agents declare typed **slots** (by `app_id`) that resolve at runtime to the
invoking user's own connection (`access='user' AND created_by=invoker`), falling
back to an org-shared connection (`access='org'`). Private connections can only
ever be slots — concrete child connections are required to be org-scoped and are
always present — so the per-user gap is **exclusively about slots**.

Today the gate that guarantees a user has the connections an agent needs is
enforced in two places, and **both only consider the *current* agent's own
slots**:

- **Client:** `AgentInsetProvider` (`agent-shell-layout/index.tsx:316-378`) calls
  `useUnresolvedSlots` and, if any slot is unresolved, renders `ConnectAgentGate`
  instead of the chat — blocking the composer before the user can type.
- **Server preflight:** `createVirtualClientFrom`
  (`mcp-clients/virtual-mcp/index.ts:149-211`) throws `SlotUnresolvedError` on
  the first unresolved slot when assembling the agent's client.

Subtask delegation is **unbounded**: a parent can delegate to *any* active
virtual MCP in the org (the model is shown the full org agent list via
`agents-block`); there is no parent→subagent relationship in the schema, and
recursion is capped at one level (subagents can't subtask). Because the gate
only checks the parent's own slots, a subagent reached via `subtask` may declare
slots the user hasn't satisfied. Today that throws `SlotUnresolvedError` inside
`subtask.ts:97` (no try/catch), which the AI SDK surfaces to the model as a
generic `"Subtask failed: …"` mid-conversation — a poor, opaque experience.

Gating the full transitive closure upfront is infeasible given unbounded
delegation (it would require the union of every org agent's slots before the
first message). We therefore move to **just-in-time** gating.

## Decisions (from brainstorm)

1. **Just-in-time, not upfront.** Delegation stays unbounded. We check slots at
   run time, asking only for the apps actually needed by the agent being run.
2. **One mechanism for both flows.** Parent and subagent both assemble their
   client through the same `createVirtualClientFrom`, which already throws
   `SlotUnresolvedError`. We upgrade that error and give it a single frontend
   renderer rather than building two paths.
3. **Consolidate into the in-run card (option B).** The upfront composer-blocking
   gate is removed. The run is the single source of truth: an unresolved slot
   (parent's own *or* a delegated subagent's) throws the structured error, which
   the chat renders as one connect card inline in the thread.
4. **Manual Retry (option A).** The card has a **Retry** button that re-runs the
   **last user turn**. No in-flight pause/resume; no auto-watching.

## Design

### 1. Structured, collect-all error (`slot-resolver.ts` + `createVirtualClientFrom`)

The slot loop currently throws on the **first** unresolved slot, so a card could
only ever show one app. Change it to resolve every slot, accumulate all
unresolved `app_id`s, and throw once at the end:

```ts
export class SlotUnresolvedError extends Error {
  readonly appIds: string[];     // was: appId: string
  readonly agentId: string;
  readonly agentTitle: string;
  constructor(appIds: string[], agentId: string, agentTitle: string) { … }
}
```

- Resolution rules unchanged (user-private preferred → org fallback).
- All-or-nothing preserved: any unresolved slot ⇒ throw (the agent cannot run
  with a partial toolset).
- This is the shared chokepoint: both the parent path
  (`harnesses/decopilot/tools.ts:136`) and the subagent path
  (`built-in-tools/subtask.ts:97`) inherit collect-all for free.

`agentId`/`agentTitle` come from the `VirtualMCPEntity` being assembled, so the
card can name which agent (parent or which subagent) needs the connections.

### 2. Catch at both boundaries, emit one typed chunk

A raw throw is swallowed as a generic failure, so each boundary catches
`SlotUnresolvedError` and writes **one** typed stream chunk:

```ts
writer.write({
  type: "data-connect-required",
  id,                                  // toolCallId (subagent) or run/message id (parent)
  data: { agentId, agentTitle, appIds },
});
```

- **Subagent boundary** (`subtask.ts`): wrap `createVirtualClientFrom` in
  try/catch. On `SlotUnresolvedError`, write the chunk keyed by `toolCallId` and
  `yield` a model-facing result (see §3) instead of letting the tool throw.
- **Parent boundary** (run setup around `runAgentLoop` / run-stream, where
  `tools.ts` assembles the client): catch the same error, write the chunk for the
  run, and end the stream cleanly (no crash).

### 3. Model-facing text (single source of truth)

From the same error the model receives plain text so it doesn't blindly retry:

> "Couldn't run **{agentTitle}** — the user must connect: GitHub, Gmail. A
> connect card was shown to the user."

- Subagent: returned via `toModelOutput`.
- Parent: included in the run's terminal assistant text.

The card (user-facing) and the text (model-facing) derive from the same
structured error, so they never drift.

### 4. Frontend — remove upfront gate, add one card renderer

- **Remove** the composer-blocking branch in `agent-shell-layout/index.tsx` (the
  `ConnectAgentGate` render path) and its use of `useUnresolvedSlots` for gating.
  Chat always renders.
- **Add** a `data-connect-required` part to the `derive-parts` pipeline
  (`components/chat/derive-parts.ts`) and a single `ConnectCard` renderer.
- The `ConnectCard` **reuses the existing building blocks**: `ConnectSlotRow`
  (per-app OAuth Connect button / connections deep-link) and `useSlotAppDisplays`
  (registry icon + friendly name). These are the same components the old
  `ConnectAgentGate` used — that reuse is the "single frontend treatment."
- The card carries a **Retry** button that re-runs the last user turn. After the
  user connects all listed apps and clicks Retry, the parent's slots resolve and
  any subtask re-issues and preflights clean.

### 5. Edge cases

- **Parallel subtasks:** each failing subtask emits its own chunk keyed by its
  `toolCallId`, so multiple cards render distinctly under their respective calls.
- **Mid-session disconnect** (org connection removed, token revoked): the next
  run throws → same card. This safety net is the upside of removing the pre-gate.
- **Non-UI / API callers:** they don't consume the chunk, but
  `SlotUnresolvedError` remains a clean structured error for them.
- **Self-fallback to org:** unchanged — a slot resolved by an org connection is
  not "unresolved" and produces no card.

### 6. Dead code

Removing the upfront gate likely leaves `ConnectAgentGate` and/or
`useUnresolvedSlots` unused. Per repo policy (knip), delete what becomes dead or
fold it into the new `ConnectCard` — do not leave orphaned exports.

## Components & boundaries

| Unit | Responsibility | Depends on |
|---|---|---|
| `SlotUnresolvedError` (`slot-resolver.ts`) | Carry `{appIds, agentId, agentTitle}` | — |
| `createVirtualClientFrom` (collect-all) | Resolve all slots; throw structured error if any unresolved | `resolveSlot` |
| subtask boundary (`subtask.ts`) | Catch error → write `data-connect-required` + model text | writer, error |
| parent boundary (run setup) | Catch error → write `data-connect-required` + end stream | writer, error |
| `derive-parts` mapping | Turn chunk into a `connect-required` part | chunk shape |
| `ConnectCard` (frontend) | Render apps + Connect + Retry | `ConnectSlotRow`, `useSlotAppDisplays` |

## Acceptance criteria

1. A parent agent with an unsatisfied slot: the user can type and send; the run
   produces a connect card (not a blocked composer, not a generic error) listing
   **all** missing apps; connecting them + Retry runs the agent successfully.
2. A subagent reached via `subtask` with a missing connection: an inline connect
   card appears under that subtask call naming the subagent; connecting + Retry
   makes the delegation succeed.
3. Multiple parallel subtasks each missing different apps render separate cards.
4. The model receives clear text and does not loop retrying the same failing
   subtask.
5. A connection removed mid-session surfaces the same card on the next run.
6. No orphaned `ConnectAgentGate` / `useUnresolvedSlots` exports (knip clean);
   `bun run check` and `bun run lint` pass.

## Testing

- **Unit (`bun test`, pure logic only):**
  - collect-all resolution: multiple unresolved slots → all present in `appIds`;
    a mix of resolved/unresolved → only unresolved reported.
  - the pure error→chunk mapping (`SlotUnresolvedError` → `data-connect-required`
    payload).
  - updated `slot-resolver.test.ts` for the new error shape.
- **E2E (Playwright):**
  - parent: unsatisfied slot → card on first message → connect → Retry → runs.
  - subagent: missing connection mid-run → inline card → connect → Retry →
    delegation succeeds.
  - parallel subtasks each show their own card.

## Out of scope (possible follow-ups)

- **Auto-retry on connect (option B from Q5):** the card already knows the
  `app_id`s, so re-checking resolution after each connect and auto-running when
  the last clears is a natural follow-up.
- **In-flight pause/resume of the subtask (option C from Q3).**
- **Bounding delegation / declared subagents (the upfront-gate alternative).**

## Key files (reference)

- `apps/mesh/src/core/slot-resolver.ts` — `SlotUnresolvedError`, `resolveSlot`.
- `apps/mesh/src/mcp-clients/virtual-mcp/index.ts:133-211` — slot resolution loop
  (collect-all change).
- `apps/mesh/src/harnesses/decopilot/built-in-tools/subtask.ts:97` — subagent
  boundary.
- `apps/mesh/src/harnesses/decopilot/tools.ts:136` — parent client assembly.
- `apps/mesh/src/harnesses/decopilot/run-agent-loop.ts` / run-stream — parent
  boundary for catch + chunk emission.
- `apps/mesh/src/web/layouts/agent-shell-layout/index.tsx:316-378` — gate removal.
- `apps/mesh/src/web/components/chat/connect-agent-gate.tsx`,
  `connect-slot-row.tsx` — reuse / consolidation source.
- `apps/mesh/src/web/components/chat/derive-parts.ts` — add the new part.
- `apps/mesh/src/web/hooks/use-slot-app-displays.ts`,
  `use-unresolved-slots.ts` — display helpers / dead-code review.
