# Harness Kernel Convergence Design

## Goal

Unify Decopilot, Claude Code, and Codex behind one Studio-owned harness
lifecycle. Harnesses should receive resolved serializable inputs, produce
`UIMessageChunk` streams, and report title, usage, session, tool side effects,
and errors through chunks or metadata. Studio owns persistence, run lifecycle,
analytics, title routing, and stream consumption.

This phase is intentionally a hard break for the local daemon protocol. We do
not need to preserve compatibility with already-shipped daemons. See "Hard
Break Mechanics" for how the break surfaces to stale daemons.

This phase also finishes transport convergence: the pull transport becomes the
only local-daemon transport, its return path becomes a raw `UIMessageChunk`
relay, and the push (`remoteDispatch`) path is deleted. See "Transport
Convergence".

## Current Gaps

These are the residual deltas (already-landed work — title interception,
side-channel streaming, HTML flush in harness, storage backchannel removal,
stub placeholders, CLI usage/session in finish metadata — is not restated):

- `HarnessProcessLocal` still carries the CLI usage callback. (The cwd
  resolver half is already dead cluster-side; only the daemon env fallback in
  `cli-cwd.ts` remains live.)
- The pull return path loses lifecycle metadata: daemon-side
  `consumePartStream` drops `data-title-result` (inert title hook), part rows
  carry `metadata: null`, and reconstructed finish chunks carry no
  `messageMetadata` — titles, usage→PostHog, and resume/session ids never
  reach the cluster for pull runs.
- Two live transports: pull serves claude-code/codex on v2 threads; push
  `remoteDispatch` still serves v1 threads and desktop Decopilot.
- Decopilot cluster and desktop use different agent loops (`run-stream.ts` vs
  `local-agent-loop.ts`, plus four hand-rolled chunk-merge loops and three
  prompt assembly paths across the harnesses).
- Claude Code and Codex still report usage through a local callback instead of
  only through stream metadata.
- Desktop Decopilot has no real local subtask loop; `subtask` is a cluster
  relay (`SUBTASK_MCP`).
- Tool vocabulary convergence is partial: some tools are portable, some are
  cluster-only, some have duplicate cluster/portable implementations, and some
  desktop tools are stubs.
- Cwd resolution is implicit and environment-specific. CLI harnesses must run
  in the repo checkout path, but that is not yet a first-class wire field.

## Architecture

Introduce a shared Harness Kernel between Studio dispatch and every harness.

The kernel is an evolution of `consumeHarnessStream` (plus
`interceptTitleChunks`), not a new parallel layer: dispatch-run's outer
`createUIMessageStream` wrapper is absorbed into it and `dispatch-run.ts` is
decomposed into thin callers. The kernel runs cluster-side only — for pull
runs the daemon relays raw chunks (see "Transport Convergence"), so the kernel
consumes every harness stream in exactly one place.

The kernel owns behavior that should be identical for Decopilot, Claude Code,
and Codex:

- consume raw harness `UIMessageChunk`s;
- intercept and persist title chunks;
- extract usage and provider/session metadata;
- persist v1/v2 messages and parts;
- route run status and errors;
- handle side-channel chunks uniformly;
- apply workspace cwd and cancellation from serializable input.

Harnesses become narrower producers:

- Decopilot uses one shared core for cluster and desktop.
- Claude Code and Codex remain CLI-backed, but no longer use `processLocal`.
- Studio dispatch resolves credentials, model slots, MCP source, object storage,
  workspace cwd, sandbox target, and subtask capability before invoking a
  harness.

Hard rule: `HarnessStreamInput` is serializable except for `signal`. No harness
receives callback-style persistence, analytics, cwd, or title hooks.

## Transport Convergence

- The pull return path becomes a raw `UIMessageChunk` relay: the daemon
  streams chunks to the cluster, where `consumeHarnessStream` consumes them.
  The daemon-side `consumePartStream` / part-row batching / row→chunk
  reconstruction path is deleted. This deliberately reverts the part-batcher's
  avoid-long-streaming-uploads rationale; in exchange the relay must handle
  reconnect/backfill (daemon buffers unacked chunks) so multi-hour runs
  survive transient drops.
- Desktop Decopilot moves to pull: work items gain Decopilot sandbox config.
  The push `remoteDispatch` path is then deleted entirely.
- Continuous chunk relay restores run liveness for long steps (progress bumps
  per relayed chunk, not per step batch), keeping healthy runs clear of the
  idle reaper.
- The ingest authz TODO is fixed in this phase as part of the return-path
  rework: `getRunFence` becomes org-scoped and thread ownership is enforced.

## Harness Input Contract

`HarnessStreamInput` should include:

```ts
workspace: {
  cwd: string;
};

models: {
  thinking: ModelInfo;
  fast?: ModelInfo;
  smart?: ModelInfo;
  image?: ModelInfo;
  deepResearch?: ModelInfo;
};

modelSources: {
  thinking: SecretModelSource;
  fast?: SecretModelSource;
  smart?: SecretModelSource;
  image?: SecretModelSource;
  deepResearch?: SecretModelSource;
};
```

- There is no `coding` slot. It never selected a model; the existing subtask
  config passthrough is removed with it. `smart` stays reserved for upcoming
  features.
- Each `models.<slot>` carries its own `credentialId` (uniform per-slot; the
  root `credentialId` is removed). Start-chunk metadata, monitoring, and
  subtask config read the per-slot value.
- The deprecated singular `modelSource` and the `primary` slot name are
  removed; `thinking` is the canonical primary slot.
- The input carries `currentThreadTitle` so the core can skip title
  generation for already-titled threads.

There is no `title` model/source slot. Decopilot title generation uses:

```ts
modelRuntime.fast ?? modelRuntime.smart ?? modelRuntime.thinking
```

The separate server-side title-tier resolution (`tryResolveTier("fast")` and
its dedicated credential) is deleted. When no fast/smart model is configured,
titles run on the thinking model and that cost is accepted. CLI harnesses keep
their internal title models (claude-code `haiku`, codex mini); the slot rule
above is Decopilot-only.

`workspace.cwd` is required and logically pre-resolved before harness
invocation — it is symbolic, not host-absolute:

- For GitHub-backed sandboxes it is the repo checkout path inside the sandbox,
  for example `/repo`. The daemon rebases it onto its local sandbox root
  (`$DATA_DIR/link/sandboxes/<handle>/...`) on receipt, which guarantees
  containment by construction — the cluster never dictates a host-absolute
  path on a user machine.
- For ephemeral or no-repo runs dispatch sends the sandbox working directory,
  or a `default` sentinel that the harness treats as "use your default". The
  harness falls back on the sentinel or a missing path; it never fails a run
  on cwd.

Claude Code, Codex, Decopilot, and Decopilot subtasks all use this same cwd.

`HarnessProcessLocal` is removed.

## Model Runtime

The shared Decopilot core receives one resolved model runtime bundle:

```ts
modelRuntime: {
  thinking: { model: ModelInfo; provider: MeshProvider };
  fast?: { model: ModelInfo; provider: MeshProvider };
  smart?: { model: ModelInfo; provider: MeshProvider };
  image?: { model: ModelInfo; provider: MeshProvider };
  deepResearch?: { model: ModelInfo; provider: MeshProvider };
};
```

`MeshProvider` and `createLanguageModel` move wholesale into portable
territory and are used on both sides; the desktop `local-language-model.ts`
mirror copy is deleted. `modelRuntime` is adapter-constructed and never
serialized — the wire carries only `models` + `modelSources`.

Cluster and desktop construct this bundle differently, but the Decopilot core
sees the same shape. Future features may use `smart` without changing the
harness contract again.

## Shared Decopilot Core

Cluster and desktop Decopilot call one shared core:

```ts
runDecopilotCore({
  input,
  modelRuntime,
  mcp,
  objectStorage,
  promptContext,
  toolRuntime,
  telemetry,
});
```

Placement: the core stays in the existing convention-guarded portable subtree
(`apps/mesh/src/harnesses/`); the daemon keeps its relative imports. No new
workspace package this phase.

Base implementation: cluster `run-stream.ts` is the base. Cluster-only pieces
(LLM-call monitoring/metrics) are pushed out into adapter hooks, and the
desktop `local-agent-loop.ts` copy is deleted.

The core owns:

- `processConversation`;
- prompt assembly (one assembler survives; the duplicate cluster prompt path
  that exists only for `_request.systemSections` debug metadata dies);
- title chunk generation, gated by `currentThreadTitle` and disabled for
  subtask runs;
- the `streamText` loop;
- side-channel merging via one shared chunk-merge utility (which also replaces
  the identical claude-code/codex merge copies);
- step-finish hooks such as HTML page flush;
- subtask spawning API.

Adapters provide environment-specific pieces:

- Cluster adapter opens in-process MCP, direct object storage, cluster
  telemetry, and Studio-backed prompt context.
- Desktop adapter opens HTTP MCP, HTTP object storage, local sandbox runner,
  no-op telemetry, and lazy Studio/MCP fetches for cross-agent subtask.
  Desktop core runs stay invisible to OTel this phase; no traceparent field is
  reserved in the protocol.

## Lifecycle Metadata

Every harness reports lifecycle facts through stream metadata or chunks:

- `data-title-result` for generated title candidates;
- final `message-metadata.usage` for token totals, cache details, and cost;
- provider metadata for resume/session ids: session reporting is MAY at the
  contract level — claude-code MUST report a session id; codex is explicitly
  exempt (resume is structurally impossible with a fresh app-server per
  request);
- data chunks for tool metadata, generated image metadata, HTML publish
  signals, and subtask metadata;
- thrown errors or SDK error chunks for failures.

`consumeHarnessStream` is the single Studio-side consumer for all harnesses
and all transports (see "Transport Convergence"). It persists messages/parts,
persists titles, extracts usage for PostHog, extracts resume/session metadata,
emits SSE title updates, and updates run status. Because raw chunks now reach
the cluster on every transport, persisted message metadata keeps
`codingAgentSessionId` and `lookupResumeSessionRef` works unchanged for v2/pull
threads.

Claude Code and Codex must stop calling usage callbacks. Their usage is read
from the same final metadata path as Decopilot.

## Local Desktop Subtask

Desktop Decopilot gets a real local `subtask` implementation. The
`SUBTASK_MCP` cluster relay and `LOCALLY_WRAPPED_RELAY_TOOLS` are deleted in
this phase — hard cutover; local subtask is the only desktop path.

Self-subtask:

- clones the current agent context;
- starts a fresh Decopilot core run in-process inside the daemon;
- inherits `workspace.cwd`;
- inherits the parent VM/sandbox runner and handle cache;
- inherits parent object storage and side-channel behavior;
- starts with a fresh message context containing the subtask prompt.

Cross-agent subtask:

- uses existing Studio/MCP APIs to fetch target virtual MCP data by id;
- needs no new mint API: the daemon points at the target agent's virtual-MCP
  URL using the run's existing minted key (org-scoped in practice);
  authorization is enforced per-call at the MCP endpoint;
- rebuilds target MCP passthrough tools and instructions for that target agent;
- reuses parent `workspace.cwd` and local sandbox;
- does not provision a new VM;
- runs the same shared Decopilot core with target agent context.

Resource policy mirrors the cluster: depth-1 (the subtask tool is excluded
from subtask toolsets), `SUBAGENT_STEP_LIMIT` step budget, a small concurrency
cap, and the parent tool-call `AbortSignal` is chained into the subtask core
run so daemon cancellation kills subtasks. Subtask core runs never generate
titles.

Subtask output is summarized into the parent tool result. The core aggregates
subtask usage into the parent run's final `message-metadata.usage` total (the
kernel sees one number); per-subtask detail is emitted as
`data-tool-subtask-metadata`.

## Tool Vocabulary And Stubs

Cluster and desktop Decopilot keep the same visible built-in tool vocabulary.

Tool categories:

- Shared real tools: VM read/write/edit/grep/glob/bash, `read_tool_output`,
  `read_resource`, `read_prompt`, `todo_write`, `propose_plan`, generated image
  metadata, and HTML page publishing.
- Desktop real tools: local `subtask`, local VM tools, HTTP MCP passthrough
  tools, and object-storage-backed resource reads.
- Cluster real tools: cluster `web_search`, `update_interests`, full Browserless
  adapters, and cluster telemetry/monitoring.
- Stubbed tools: visible tools without an implementation in the current runtime
  return clear structured errors.

The core uses one implementation per tool; environment differences live in the
`toolRuntime` adapter. Existing duplicate cluster/portable implementations
(`generate_image`, `take_screenshot`, `scrape_url`, `inspect_page`) converge
as part of the core extraction.

Stubs are allowed for vocabulary compatibility. The implementation plan must
list every stub explicitly and state whether it should become local,
relay-backed, or remain cluster-only.

## Hard Break Mechanics

- Bump `LINK_PROTOCOL_VERSION` and `MIN_SUPPORTED_LINK_PROTOCOL`. Stale
  daemons receive an explicit `protocol_mismatch`/426 with "re-run
  `bunx decocms@latest link`" messaging — never silent Zod failures.
- New-shape schemas reject (not `.strip()`) old inputs.
- In-flight old-shape work items at deploy time fail cleanly with a
  run-failure event rather than sticking in the queue.
- Work-queue hardening (minimal, in scope): `LINK_WORK_QUEUE` gets a `max_age`
  TTL and work-item validity is bound to `mcp.expiresAt` — stale items are
  rejected at claim time. The full secrets-out-of-queue redesign (daemon
  fetching model sources at claim time) is a documented follow-up, not this
  phase.

## Implementation Strategy

Use tests to force the new architecture before removing old paths. The work
lands as one long-lived branch / mega-PR; the steps below are internal
sequencing, not PR boundaries.

1. Add contract tests for the desired final shape:
   - `HarnessStreamInput` has no `processLocal`;
   - `workspace.cwd` is required, symbolic, with the `default` sentinel;
   - model slots are `thinking`, `fast`, `smart`, `image`, `deepResearch`,
     each carrying `credentialId` — no `coding`, no `title`, no singular
     `modelSource`, no `primary`;
   - all harnesses report usage and title through chunks/metadata; session is
     MUST for claude-code, exempt for codex;
   - link protocol round-trips `workspace` and all model slots, rejects the
     old shape, and pins the bumped protocol version.
2. Build the kernel consumer contract:
   - extend `consumeHarnessStream` for usage across all harnesses (including
     cache details and cost);
   - extract resume/session metadata for Claude Code;
   - absorb dispatch-run's outer `createUIMessageStream` layer;
   - remove CLI usage callbacks.
3. Replace CLI cwd:
   - dispatch resolves symbolic `workspace.cwd`;
   - the daemon rebases it onto the sandbox root;
   - Claude Code and Codex use only `input.workspace.cwd`;
   - remove `cli-cwd.ts` and `HarnessProcessLocal`.
4. Converge transports:
   - raw chunk relay return path with reconnect/backfill;
   - fix ingest fence org-scoping and thread ownership;
   - work items carry Decopilot sandbox config; desktop Decopilot goes pull;
   - delete the part-row reconstruction path and push `remoteDispatch`;
   - bump the protocol version and add queue `max_age`/`expiresAt` claim
     checks.
5. Extract shared Decopilot core:
   - `run-stream.ts` becomes `runDecopilotCore`; cluster-only monitoring moves
     into adapter hooks; `local-agent-loop.ts` is deleted;
   - move `MeshProvider`/`createLanguageModel` into portable territory;
   - adapters supply model runtime, MCP runtime, object storage, prompt
     context, tool runtime, and telemetry.
6. Implement desktop local subtask:
   - self-subtask first inside the shared core;
   - cross-agent fetch/rebuild through existing Studio/MCP APIs with the
     run's existing minted key;
   - same `workspace.cwd` and local sandbox handle, cluster resource policy,
     signal chaining;
   - delete the `SUBTASK_MCP` relay and `LOCALLY_WRAPPED_RELAY_TOOLS`.
7. Remove transitional branches once the conformance suite and the manual
   checklist below pass for both cluster and desktop.

## Testing

Tier mapping (per TESTING.md's two-tier policy):

- harness input contract tests and link protocol schema tests — unit
  (type-level + Zod, no collaborators);
- `consumeHarnessStream` metadata extraction tests — unit over synthetic
  chunk streams (data-boundary fixtures, like the existing
  consume-harness-stream tests);
- cluster/desktop Decopilot core adapter tests, local self-subtask and
  cross-agent subtask tests, and tool vocabulary/stub behavior tests —
  multi-pod suites with the mock-AI provider, including a shared
  parameterized conformance suite that runs the same behavior cases against
  the cluster and desktop adapters (this suite is the step-7 removal gate);
- Claude Code/Codex usage, session, and cwd behavior — manual checklist plus
  the existing skipped e2e title specs run locally with real keys.

Manual checklist (release gate together with the conformance suite):

- real `decocms link` daemon turn end-to-end, including a self-subtask and a
  cross-agent subtask;
- a real Claude Code run and a real Codex run on agent-sandbox verifying usage
  rows, claude-code session resume across turns, and that the CLI executed in
  the checkout cwd (a file edit lands in the repo, not the app root);
- stale-daemon experience: an old daemon against the new cluster surfaces the
  `protocol_mismatch` message, not a silent failure.

Repository verification should include `bun run fmt`, `bun run check`,
`bun run lint`, and focused tests. Full `bun test` is useful when local
resilience services are available, but it should not be the only proof because
some resilience tests wait for external studio health.

## Decision Log (plan review + interview, 2026-06-09)

A multi-perspective plan review raised 25 open questions; all were resolved by
interview and folded into the body above. Summary:

- **Pull topology**: raw `UIMessageChunk` relay to the cluster; kernel runs
  cluster-side only; part-row reconstruction deleted. Desktop Decopilot moves
  to pull; push `remoteDispatch` dies. Session ids survive via normal message
  persistence; codex is exempt from session reporting (MAY/MUST split).
- **cwd**: symbolic wire value rebased by the daemon onto its sandbox root;
  required with a `default` sentinel for no-repo runs; harness falls back,
  never fails; containment by construction.
- **Core placement**: stays in `apps/mesh/src/harnesses/` (no new package);
  `MeshProvider` + `createLanguageModel` move wholesale into portable
  territory; `run-stream.ts` is the base, `local-agent-loop.ts` deleted;
  kernel = evolved `consumeHarnessStream`, dispatch-run decomposed.
- **Model slots**: keep `smart`, remove `coding` (including its subtask
  passthrough); per-slot `credentialId`; delete the server-side title-tier
  resolution (accept thinking-model titles when no fast/smart); title
  generation gated by `currentThreadTitle` in the core and disabled for
  subtasks; CLI harnesses keep their internal title models.
- **Subtask**: no new mint API (existing run key + target virtual-MCP URL,
  per-call authz at the endpoint); `SUBTASK_MCP` relay deleted this phase;
  cluster resource policy mirrored (depth-1, step limit, concurrency cap,
  signal chaining); usage aggregated into the parent total plus per-subtask
  metadata chunks.
- **Hard break**: protocol version bump + 426 messaging + reject-not-strip;
  in-flight old items fail cleanly; queue `max_age` + `mcp.expiresAt` claim
  binding in scope; full secrets-out-of-queue is a follow-up.
- **Ingest authz**: fence org-scoping + thread ownership fixed in this phase.
- **Testing**: pragmatic tier mapping; shared parameterized conformance suite
  (multi-pod, mock-AI) + written manual checklist as the removal gate.
- **Sequencing**: one long-lived branch / mega-PR; steps are internal
  sequencing only.
- **Telemetry**: desktop core runs stay invisible to OTel this phase; no
  traceparent field reserved.

Critique decisions:

- **Adopted**: pull-path lifecycle metadata gap (resolved via chunk relay);
  symbolic cwd + sentinel; protocol version bump with reject semantics;
  ingest authz fix; subtask resource policy + usage roll-up; title-generation
  gating; per-slot `credentialId`; dropping `coding`; deleting the singular
  `modelSource`/`primary` aliases; queue TTL hardening; test tier mapping +
  conformance suite + manual checklist; "Current Gaps" rewritten to the
  residual delta.
- **Rejected**: splitting into sequenced PRs (mega-PR accepted); dropping the
  `smart` slot (kept, `coding` dropped instead); desktop telemetry plumbing
  (stays invisible, no protocol field reserved); secrets-out-of-queue redesign
  (minimal TTL hardening only); a dedicated mint-for-target-agent API
  (per-call endpoint authz accepted); keeping the `SUBTASK_MCP` relay as
  fallback (hard cutover).
- **Adapted**: "single Studio-side consumer" kept as the goal but made true by
  changing the transport (chunk relay) rather than splitting the kernel;
  "pre-resolved cwd" reinterpreted as logically resolved symbolic value rather
  than host-absolute path.
