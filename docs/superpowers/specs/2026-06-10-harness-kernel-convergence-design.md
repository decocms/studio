# Harness Kernel Convergence Design

## Goal

Unify Decopilot, Claude Code, and Codex behind one Studio-owned harness
lifecycle. Harnesses should receive resolved serializable inputs, produce
`UIMessageChunk` streams, and report title, usage, session, tool side effects,
and errors through chunks or metadata. Studio owns persistence, run lifecycle,
analytics, title routing, and stream consumption.

This phase is intentionally a hard break for the local daemon protocol. We do
not need to preserve compatibility with already-shipped daemons.

## Current Gaps

- `HarnessProcessLocal` still carries non-serializable callbacks for CLI cwd
  and usage.
- Decopilot cluster and desktop use different agent loops and prompt/tool
  assembly paths.
- Claude Code and Codex still report usage through a local callback instead of
  only through stream metadata.
- Desktop Decopilot has no real local subtask loop for self or cross-agent
  delegation.
- Tool vocabulary convergence is partial: some tools are portable, some are
  cluster-only, and some desktop tools are stubs.
- Cwd resolution is implicit and environment-specific. CLI harnesses must run
  in the repo checkout path, but that is not yet a first-class wire field.

## Architecture

Introduce a shared Harness Kernel between Studio dispatch and every harness.

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
  coding?: ModelInfo;
  image?: ModelInfo;
  deepResearch?: ModelInfo;
};

modelSources: {
  thinking: SecretModelSource;
  fast?: SecretModelSource;
  smart?: SecretModelSource;
  coding?: SecretModelSource;
  image?: SecretModelSource;
  deepResearch?: SecretModelSource;
};
```

There is no `title` model/source slot. Title generation uses:

```ts
modelRuntime.fast ?? modelRuntime.smart ?? modelRuntime.thinking
```

`workspace.cwd` is required and pre-resolved before harness invocation. For
GitHub-backed sandboxes it points to the repo checkout path, for example
`/repo`. For ephemeral or no-repo runs it points to the sandbox working
directory. Claude Code, Codex, Decopilot, and Decopilot subtasks all use this
same cwd.

`HarnessProcessLocal` is removed.

## Model Runtime

The shared Decopilot core receives one resolved model runtime bundle:

```ts
modelRuntime: {
  thinking: { model: ModelInfo; provider: MeshProvider };
  fast?: { model: ModelInfo; provider: MeshProvider };
  smart?: { model: ModelInfo; provider: MeshProvider };
  coding?: { model: ModelInfo; provider: MeshProvider };
  image?: { model: ModelInfo; provider: MeshProvider };
  deepResearch?: { model: ModelInfo; provider: MeshProvider };
};
```

Cluster and desktop can construct this bundle differently, but the Decopilot
core sees the same shape. Future features may use `smart` or `coding` without
changing the harness contract again.

## Shared Decopilot Core

Cluster and desktop Decopilot should call one shared core:

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

The core owns:

- `processConversation`;
- prompt assembly;
- title chunk generation;
- the `streamText` loop;
- side-channel merging;
- step-finish hooks such as HTML page flush;
- subtask spawning API.

Adapters provide environment-specific pieces:

- Cluster adapter opens in-process MCP, direct object storage, cluster telemetry,
  and Studio-backed prompt context.
- Desktop adapter opens HTTP MCP, HTTP object storage, local sandbox runner, and
  lazy Studio/MCP fetches for cross-agent subtask.

## Lifecycle Metadata

Every harness reports lifecycle facts through stream metadata or chunks:

- `data-title-result` for generated title candidates;
- final `message-metadata.usage` for token totals, cache details, and cost;
- provider metadata for resume/session ids or provider-specific thread ids;
- data chunks for tool metadata, generated image metadata, HTML publish signals,
  and subtask metadata;
- thrown errors or SDK error chunks for failures.

`consumeHarnessStream` is the single Studio-side consumer for all harnesses. It
persists messages/parts, persists titles, extracts usage for PostHog, extracts
resume/session metadata, emits SSE title updates, and updates run status.

Claude Code and Codex must stop calling usage callbacks. Their usage is read
from the same final metadata path as Decopilot.

## Local Desktop Subtask

Desktop Decopilot gets a real local `subtask` implementation.

Self-subtask:

- clones the current agent context;
- starts a fresh Decopilot core run in-process inside the daemon;
- inherits `workspace.cwd`;
- inherits the parent VM/sandbox runner and handle cache;
- inherits parent object storage and side-channel behavior;
- starts with a fresh message context containing the subtask prompt.

Cross-agent subtask:

- uses existing Studio/MCP APIs to fetch target virtual MCP data by id;
- rebuilds target MCP passthrough tools and instructions for that target agent;
- reuses parent `workspace.cwd` and local sandbox;
- does not provision a new VM;
- runs the same shared Decopilot core with target agent context.

Subtask output is summarized into the parent tool result. Subtask details may be
emitted as `data-tool-subtask-metadata`.

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

Stubs are allowed for vocabulary compatibility. The implementation plan must
list every stub explicitly and state whether it should become local,
relay-backed, or remain cluster-only.

## Implementation Strategy

Use tests to force the new architecture before removing old paths.

1. Add contract tests for the desired final shape:
   - `HarnessStreamInput` has no `processLocal`;
   - `workspace.cwd` is required;
   - model slots include `thinking`, `fast`, `smart`, `coding`, `image`, and
     `deepResearch`;
   - there is no `title` model/source slot;
   - all harnesses report usage, session, and title through chunks/metadata;
   - link protocol round-trips `workspace` and all model slots.
2. Build the kernel consumer contract:
   - extend `consumeHarnessStream` for usage across all harnesses;
   - extract resume/session metadata for Claude Code and Codex;
   - remove CLI usage callbacks.
3. Replace CLI cwd:
   - dispatch resolves `workspace.cwd`;
   - Claude Code and Codex use only `input.workspace.cwd`;
   - remove `cli-cwd.ts` and `HarnessProcessLocal`.
4. Extract shared Decopilot core:
   - move common cluster/desktop loop pieces into `runDecopilotCore`;
   - adapters supply model runtime, MCP runtime, object storage, prompt context,
     tool runtime, and telemetry.
5. Implement desktop local subtask:
   - self-subtask first inside the shared core;
   - cross-agent fetch/rebuild through existing Studio/MCP APIs;
   - use the same `workspace.cwd` and local sandbox handle.
6. Remove transitional branches after tests prove cluster and desktop pass the
   same harness behavior cases.

## Testing

Required focused suites:

- harness input contract tests;
- link protocol schema tests;
- `consumeHarnessStream` metadata extraction tests;
- Claude Code/Codex usage, session, and cwd tests;
- cluster Decopilot core adapter tests;
- desktop Decopilot core adapter tests;
- local self-subtask and cross-agent subtask tests;
- tool vocabulary/stub behavior tests.

Repository verification should include `bun run fmt`, `bun run check`,
`bun run lint`, and focused tests. Full `bun test` is useful when local
resilience services are available, but it should not be the only proof because
some resilience tests wait for external studio health.
