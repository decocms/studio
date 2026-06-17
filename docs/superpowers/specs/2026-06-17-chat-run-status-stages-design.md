# Chat run status stages

- **Date:** 2026-06-17
- **Status:** Draft design
- **Author:** gimenes (with Codex)
- **Area:** `apps/mesh` chat UI / Decopilot streaming / DBOS dispatch

## Problem

When a chat turn starts, the UI currently shows a local waiting animation that
flips from "Planning next moves" to "Thinking" after a timer. That copy is not
tied to the actual backend lifecycle.

The real path has several meaningful stages before the assistant produces
visible output:

- `POST /messages` accepts the user message and enqueues work.
- The DBOS thread gate waits for the per-thread dispatch slot.
- A worker picks the run and prepares dispatch.
- Decopilot loads context, resolves tools/models, and starts the harness.
- The model loop starts and eventually emits visible text, reasoning, or tool
  activity.

Users need clearer feedback during this silent startup window. The UI should
say what is happening in business-friendly language while still exposing enough
technical detail to make delays understandable.

## Goal

Replace timer-only startup copy with backend-authored run lifecycle stages,
streamed through the existing chat stream, and rendered by React as:

- a friendly primary label;
- a muted technical detail line;
- the existing elapsed-time and slow-turn affordances.

The backend should stream only stable semantic stage IDs. Product copy,
descriptions, and icons belong in the React code so they can change without
touching stream producers.

## Non-goals

- Do not create a new realtime channel or status endpoint.
- Do not persist run-status copy as transcript content.
- Do not expose DBOS, NATS, JetStream, or harness terms as the primary user
  label.
- Do not change the durable projector or message-parts persistence model.
- Do not show desktop-only startup states in the cluster Decopilot path.

## Chosen approach

Use a hidden AI SDK data chunk:

```ts
{
  type: "data-run-status",
  id: "run-status",
  data: {
    stage: RunStatusStage,
  },
}
```

`stage` is the only product-independent wire contract. Timing can be inferred
from client receipt time or server logs; it is intentionally not part of the
chunk payload.

The client already observes `data-*` chunks through `ThreadObserver.onData`, and
assistant rendering already ignores known data parts that should not appear as
normal transcript content. `data-run-status` follows that pattern: it updates
the waiting placeholder but does not render as a chat message part.

## Stage enum

```ts
type RunStatusStage =
  | "sending"
  | "received"
  | "waiting-runner"
  | "starting-run"
  | "gathering-context"
  | "preparing-tools"
  | "starting-assistant"
  | "analyzing-scope"
  | "choosing-next-steps";
```

Desktop-specific stages are intentionally not part of the cluster Decopilot v1
sequence:

```ts
type DesktopRunStatusStage =
  | "connecting-desktop"
  | "desktop-starting"
  | "preparing-workspace";
```

Those can be added later when the desktop pull path gets the same UI treatment.

## React copy map

React owns labels and descriptions:

```ts
const RUN_STATUS_COPY = {
  sending: {
    label: "Sending your message",
    detail: "Posting the message to the thread",
  },
  received: {
    label: "Request received",
    detail: "The run was accepted and queued",
  },
  "waiting-runner": {
    label: "Waiting for an available runner",
    detail: "Waiting for the per-thread dispatch slot",
  },
  "starting-run": {
    label: "Starting the run",
    detail: "A worker picked up the queued message",
  },
  "gathering-context": {
    label: "Gathering context",
    detail: "Loading history, memory, files, and agent context",
  },
  "preparing-tools": {
    label: "Preparing tools",
    detail: "Resolving models, permissions, MCP tools, and built-ins",
  },
  "starting-assistant": {
    label: "Starting the assistant",
    detail: "Opening the cluster Decopilot harness",
  },
  "analyzing-scope": {
    label: "Analyzing scope",
    detail: "The model loop is running before first output",
  },
  "choosing-next-steps": {
    label: "Choosing next steps",
    detail: "The assistant is planning the next action",
  },
} as const;
```

If an unknown stage arrives, the UI falls back to the existing generic
"Thinking" state and logs a development warning. Unknown stages should not fail
the stream.

## Cluster Decopilot sequence

For Decopilot running on the cluster, the visible startup sequence is:

1. `sending` - local frontend state while `POST /messages` is in flight.
2. `received` - local frontend state after `POST /messages` returns `202`.
3. `waiting-runner` - backend stage while the run waits behind the thread gate
   or an available DBOS worker.
4. `starting-run` - backend stage when a worker enters dispatch for the queued
   message.
5. `gathering-context` - backend stage while `prepareRun` loads thread history,
   memory, user context, agent data, and referenced message/file material.
6. `preparing-tools` - backend stage while Decopilot resolves models,
   permissions, virtual MCP/tool availability, built-ins, and prompt inputs.
7. `starting-assistant` - backend stage immediately before the cluster
   Decopilot harness is dispatched.
8. `analyzing-scope` - backend stage after the harness/model loop starts but
   before the first visible output.
9. `choosing-next-steps` - optional backend stage when an agent step boundary
   occurs before any visible output.

The UI stops showing the run-status placeholder as soon as the assistant message
has visible content: text, reasoning, tool input, approval request, generated
file card, or other rendered part.

## Backend emission points

### Local/client-only stages

`sending` and `received` do not need NATS. They are deterministic client states:

- `sending`: set before `ThreadConnection.post()`.
- `received`: set after the POST succeeds with `202`.

If POST fails, the normal chat error path replaces the status.

### Streamed backend stages

Backend stages should be emitted as `data-run-status` chunks into the existing
per-thread stream. They should use the same stream infrastructure as other
`data-*` chunks, not a separate SSE event.

Cluster Decopilot emission points:

- `waiting-runner`: after `POST /messages` enqueues `threadGateWorkflow`, if the
  stream buffer is available. If the publish fails or the stream buffer is not
  available, the UI keeps the local `received` state until a later stage arrives.
- `starting-run`: at the beginning of `dispatchRunAndWaitStep`, before
  `prepareRun`.
- `gathering-context`: early in `prepareRun`, before loading memory,
  virtual MCP, user context, and materialized messages.
- `preparing-tools`: after core context is loaded, while resolving effective
  agent/tool/model configuration and building the harness input.
- `starting-assistant`: immediately before constructing/dispatching the
  cluster harness stream.
- `analyzing-scope`: when the lazy harness stream is first consumed and before
  yielding the harness chunks.
- `choosing-next-steps`: v1 does not add new backend logic for this. It may be
  emitted only if an existing agent-loop step boundary is already available
  before visible output; otherwise the first rendered reasoning/tool/text part
  takes over.

The backend should not emit `sending` because POST has not completed yet and the
chat stream is independent from the POST response.

## UI behavior

`ThreadConnection` stores the latest run-status stage in a small store alongside
`messages`, `status`, and `finishReason`.

On `data-run-status`, the observer updates the stage store. The stage is scoped
to the active run and cleared when:

- a new `start` chunk opens an assistant message and visible content appears;
- a `finish` chunk arrives;
- the user stops the run;
- the connection enters an error state;
- the user submits the next message.

`ThinkingState` becomes `RunStatusState`:

- If a stage is present, render its `label` and `detail`.
- If no stage is present, keep the current fallback behavior.
- Keep `LiveTimer`.
- Keep the slow-turn threshold and Cancel affordance.

The status component should remain compact:

```txt
Gathering context...
Loading history, memory, files, and agent context
00:07
```

## Ordering and monotonicity

The UI should treat stages as monotonic within one run. If older or repeated
stage chunks arrive because of SSE reconnect/replay, the UI should keep the
furthest known stage according to the stage order.

Suggested order:

```ts
[
  "sending",
  "received",
  "waiting-runner",
  "starting-run",
  "gathering-context",
  "preparing-tools",
  "starting-assistant",
  "analyzing-scope",
  "choosing-next-steps",
]
```

This prevents a replayed `starting-run` from replacing `analyzing-scope` after a
reconnect.

## Error handling

- Unknown stage: ignore for display, keep the previous stage or fallback copy.
- Malformed `data-run-status`: ignore for display; do not fail the chat stream.
- POST failure before `received`: normal POST error handling.
- Backend setup failure after a streamed stage: normal error chunk/rendering
  replaces the waiting status.
- Missing backend stages: the local fallback still shows useful copy and timer.

## Testing

Unit tests:

- Stage copy map returns the expected label/detail for every enum value.
- Unknown/malformed stage chunks do not crash the stream.
- Stage updates are monotonic and tolerate replay.
- Visible assistant content hides the run-status placeholder.
- POST state transitions set `sending` then `received`.

Backend unit tests:

- A helper builds valid `data-run-status` chunks.
- Emission points produce the expected stage order for the cluster path.
- Stream chunk validation accepts `data-run-status`.

Integration/e2e:

- A cluster Decopilot run shows `received`, then backend-authored stages before
  first output.
- A delayed DBOS dispatch remains on `waiting-runner`.
- A setup failure after `starting-run` surfaces the existing error UI.
- A reconnect/replay does not move the UI backward.

## Deferred decisions

- Whether desktop path stages should be added in the same implementation pass
  or left for a separate follow-up once the cluster path is proven. The v1
  recommendation is to keep desktop stages out of scope.
- Whether future clients need localized copy maps. The v1 implementation keeps
  copy in the React client only.
