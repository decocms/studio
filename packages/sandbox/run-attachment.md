# First-class run attachment for sandboxes

> Status: proposed follow-up after
> [PR #4638](https://github.com/decocms/studio/pull/4638). This design is not a
> prerequisite for merging that PR.

## Context

PR #4638 makes MCP tools scriptable inside a sandbox by materializing a tool
catalog under `.deco/tools/` and a short-lived MCP endpoint in
`.deco/.endpoint.json`. The daemon owns the materialization primitive, while the
point that triggers it depends on how a run reaches the sandbox.

The implementation is deliberately narrow, but it exposes a broader lifecycle
gap: Studio has a sandbox lifecycle and a run lifecycle, without a first-class
operation that attaches a run's context to an existing sandbox.

## Current topology

| Runtime path | How run context reaches the workspace |
| --- | --- |
| Desktop `/dispatch` | The sandbox daemon receives the dispatch envelope and invokes the catalog-sync hook. |
| Hosted Decopilot with `agent-sandbox` | Studio provisions or reuses the sandbox, then calls `/_sandbox/tools/sync`. Thread identity is also sent on filesystem and exec calls so the daemon can repoint run-specific links. |
| Hosted Claude Code and Codex | The harness runs on the Studio side with its own working directory; it does not currently use the sandbox filesystem. |

This is not three catalog implementations. Catalog fetching and file writing
remain daemon-owned. The smell is the set of topology-specific triggers and
headers needed to reconstruct run context in a sandbox-scoped filesystem.

## Proposed direction

Introduce one explicit, authenticated, idempotent **run attachment** operation.
The exact wire contract still needs design, but it could resemble:

```http
POST /_sandbox/runs/:runId/attach
```

```json
{
  "threadId": "thread-id",
  "mcp": {
    "url": "https://studio.example.com/mcp",
    "headers": {
      "authorization": "Bearer <short-lived-token>"
    },
    "expiresAt": "2026-07-15T15:00:00.000Z"
  }
}
```

The operation should own all filesystem state derived from the association
between a run and a sandbox, including:

- thread and organization workspace links;
- the MCP endpoint and generated tool catalog;
- expiry, refresh, detach, and cleanup metadata.

Desktop dispatch and hosted sandbox provisioning should call the same internal
attachment service. `/dispatch` may continue to invoke it in-process, while a
remote provider may use the authenticated route.

The payload above is illustrative, not a committed public API. In particular,
the final design should avoid making a sandbox-global mutable symlink or
credential file appear run-scoped when multiple runs can use the sandbox at the
same time.

## Requirements and risks to resolve

### Concurrency and ownership

An ephemeral Decopilot sandbox can be shared by multiple threads. Today, files
such as `.deco/.endpoint.json` and links such as `org/output` have a single
workspace-wide value, so concurrent runs can overwrite each other's context.
The follow-up must choose and enforce one ownership model:

- isolate derived state by run and make commands resolve through that run;
- serialize attachments and explicitly allow only one active run; or
- make all mutable context operation-scoped instead of changing global links.

Last-writer-wins behavior must not be an accidental API.

### Reliability

The hosted catalog sync introduced in PR #4638 is best-effort and
fire-and-forget. A command can therefore inspect `.deco/tools/` before the first
sync finishes. Run attachment should define:

- whether attachment is a readiness barrier before the first command;
- retry and acknowledgement semantics;
- idempotency across daemon restarts and sandbox reprovisioning;
- what remains usable when catalog refresh fails but an older catalog exists.

### Credential lifecycle

The endpoint file contains an authorization header. It is mode `0600` and
excluded from the generated catalog's git surface, but a complete lifecycle
also needs:

- refresh before `expiresAt` rather than a one-time token snapshot;
- removal on detach, expiry, or ownership change;
- protection against one attached run reading another run's credentials;
- confirmation that credentials cannot be committed or included in artifacts.

### Runtime coverage

A sandbox run-attachment API covers Desktop dispatch and hosted runtimes backed
by `agent-sandbox`. It does not, by itself, make tools available to hosted
Claude Code or Codex because those harnesses currently execute outside the
sandbox. Supporting those runtimes requires either a harness-level workspace
materialization capability or moving their execution into the sandbox. That is
a related decision, not an implicit promise of this refactor.

## Migration sketch

1. Extract an internal daemon `attachRun` service that validates run context and
   owns all run-derived materializers.
2. Define the concurrency and state-isolation model before exposing the remote
   route.
3. Have Desktop `/dispatch` invoke `attachRun` after validating its envelope.
4. Have hosted provisioning/reuse invoke the authenticated attachment operation
   and observe its readiness result.
5. Move catalog sync and thread-link initialization behind that service.
6. Keep `/_sandbox/tools/sync` and per-operation thread headers as compatibility
   paths during rollout, then remove them after every caller migrates.
7. Add refresh, detach, expiry, and stale-run cleanup.

## Validation matrix

The refactor is complete only when black-box tests cover:

- first Desktop dispatch into a new and an existing sandbox;
- first hosted Decopilot command, sandbox reuse, daemon restart, and sandbox
  reprovisioning;
- repeated attachment and retry after a lost response;
- the chosen simultaneous-run and simultaneous-thread policy;
- token refresh and rejection or cleanup after expiry;
- cancellation and detach cleanup;
- absence of credentials from git-visible files and produced artifacts;
- an explicit supported-or-not-supported decision for hosted Claude Code and
  Codex.

## Non-goals for PR #4638

- Rewriting sandbox providers or run orchestration.
- Blocking the initial tool-catalog feature on a larger lifecycle refactor.
- Claiming identical filesystem behavior for runtimes that do not share a
  sandbox workspace.
