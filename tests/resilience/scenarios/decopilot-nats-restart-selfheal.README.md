# Stream-of-record NATS-restart self-heal — harness support needed

`decopilot-nats-restart-selfheal.test.ts` proves the stream-of-record
guarantee: when NATS drops mid-stream the **live deltas are lost (accepted B2
regression)** but **the result survives in Postgres `thread_message_parts`**,
and a reconnect **re-folds the parts into a COMPLETE message** (C1 / B1 / B4),
never truncated-as-final.

The toxiproxy / poll / Postgres-query / `foldParts` wiring in that file is
**real and runnable today** (the `"durable-channel query + fold wiring is
live"` test exercises it against the containerized Postgres). The actual
self-heal test is `test.skip`ped because **the resilience harness cannot drive
a v2 streaming chat turn yet.** This note is the precise checklist to make it
runnable.

## Why it can't run today

A v2 streaming turn requires the full decopilot dispatch pipeline:
`POST /:org/decopilot/threads/:threadId/messages` → `enqueueThreadRun` →
`dispatch-run.ts` (`streamText` against a model) → `onStepFinish`/`onFinish` →
`PartEmitter` writes `thread_message_parts` rows. Three things block that in
`tests/resilience/`:

| # | Gap | Where | Fix |
|---|-----|-------|-----|
| 1 | **No model provider.** `streamText` and tier resolution need an OpenAI-compatible endpoint. The resilience `docker-compose.yml` has no `mock-ai` service. | `tests/resilience/docker-compose.yml` | Port the `mock-ai` service from `tests/multi-pod/docker-compose.yml` (build context `./mock-ai`, copy `tests/multi-pod/mock-ai/`). It already supports `slow:<n>x<ms>` hints, which is exactly what this scenario needs to keep a stream open while NATS is severed. |
| 2 | **v2 is off.** No `STREAM_OF_RECORD_V2_PERCENT`, so every new thread stays `message_storage_version=1` and **no parts are ever written**. | `studio` service env in the compose | Add `STREAM_OF_RECORD_V2_PERCENT: "100"` so the new thread is pinned v2 at its first-message site (see `apps/mesh/src/api/routes/decopilot/v2-canary.ts`). |
| 3 | **Dispatch 409s.** `studio` runs `STUDIO_SANDBOX_PROVIDER=user-desktop` and the `link-daemon` is behind a compose profile (not started by `up --wait`). With no link claim, `resolveDispatchTarget` returns `user_desktop_link_offline` → `POST /messages` 409s before dispatch. | `studio` service env in the compose | Run the turn with `STUDIO_SANDBOX_PROVIDER=cluster` (as multi-pod does) so dispatch short-circuits to the cluster default. The mock-ai stream never emits tool calls, so no sandbox is provisioned (`ensureSandbox` is lazy). |

> ⚠️ Changing the shared `studio` service env (#2, #3) would alter behaviour for
> **every** resilience scenario in the suite (they all reuse the one `studio`
> container via `registerTestHooks`). Two clean options:
>
> - **Dedicated service.** Add a second studio service (e.g. `studio-v2`) with
>   `STREAM_OF_RECORD_V2_PERCENT=100` + `STUDIO_SANDBOX_PROVIDER=cluster` + the
>   `mock-ai` dependency, on its own host port, and point this scenario at it.
>   Keeps the existing scenarios byte-for-byte unchanged. **Preferred.**
> - **Flip the shared env.** Set the two vars on the shared `studio` service and
>   re-validate the whole suite. Simpler compose, but couples this scenario's
>   needs to every other scenario.

## The missing `driveV2Turn` helper

Once the compose gaps are closed, implement a `driveV2Turn` helper (mirror
`tests/multi-pod/lib/setup.ts` — `bootstrapSession` + `wireMockProvider` +
`createTestAgent` + `createTestThread`, then `POST .../messages`). Suggested
shape:

```ts
interface DriveV2TurnResult {
  threadId: string;
  orgSlug: string;
  apiKey: string;
}

// Bootstraps a fresh user/org, wires the mock-ai credential to the "smart"
// tier, creates an agent + a brand-new thread (which the V2_PERCENT=100 canary
// pins to message_storage_version=2 at first message), and POSTs a streaming
// user message. Returns once POST /messages returns 202.
async function driveV2Turn(opts: {
  prompt: string; // e.g. "slow:20x500" — mock-ai hint for a slow multi-chunk stream
}): Promise<DriveV2TurnResult>;
```

The bodies of `bootstrapSession` / `wireMockProvider` / `createTestAgent` /
`createTestThread` can be lifted almost verbatim from `tests/multi-pod/lib/setup.ts`
(swap the multi-pod `PodInfo`-based client for the resilience `fetchStudio` /
`mcpCall` helpers in `tests/resilience/lib/studio-client.ts`).

## Un-skipping

1. Land compose gaps #1–#3 (prefer the dedicated `studio-v2` service).
2. Implement `driveV2Turn` and uncomment the call at the top of the skipped
   test body; replace the `const threadId = "<provided by driveV2Turn>"`
   placeholder with its result.
3. Delete the `.skip`. The toxiproxy/poll/DB/fold assertions below it are
   already complete and need no further edits.

## What's verified by unit / integration tests already (Tasks 1–9)

The *durable write/read correctness* — `foldParts` (C5), the storage adapter
(C1/C2/C5/R14/R18), the v2 read-path branch — is covered by co-located unit /
integration tests and `apps/mesh/e2e/tests/decopilot-parts-readpath.spec.ts`.
This resilience scenario adds the missing piece: the **end-to-end self-heal
across a real NATS fault**, which only the container harness can prove.
