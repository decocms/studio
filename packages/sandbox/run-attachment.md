# First-class run attachment for hosted sandboxes

> Status: proposed follow-up after
> [PR #4638](https://github.com/decocms/studio/pull/4638). This design is not a
> prerequisite for that PR.

## Context

Studio's hosted Decopilot runtime can provision or reuse an `agent-sandbox` and
materialize a tool catalog under `.deco/tools/`. The sandbox lifecycle and the
hosted run lifecycle are separate, but there is no first-class operation that
attaches one run's short-lived context to an existing sandbox.

Native Claude Code, Codex, and OpenCode sessions do not use this path. They run
as real interactive PTYs in Studio Native and receive their selected MCP and
workspace configuration directly from the native terminal runtime.

## Current topology

| Runtime path | How run context reaches the workspace |
| --- | --- |
| Hosted Decopilot with `agent-sandbox` | Studio provisions or reuses the sandbox, then calls `/_sandbox/tools/sync`. Thread identity is sent on filesystem and exec calls so the daemon can repoint run-specific links. |
| Studio Native coding-agent terminal | The Rust terminal runtime launches the selected local CLI in the chosen workspace. It does not send a daemon dispatch envelope or use hosted run attachment. |

Catalog fetching and file writing remain daemon-owned. The lifecycle gap is
limited to hosted sandbox runs and the topology-specific calls and headers used
to reconstruct their context in a sandbox-scoped filesystem.

## Proposed direction

Introduce one explicit, authenticated, idempotent run-attachment operation for
hosted sandboxes. The exact wire contract still needs design, but it could
resemble:

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
between a hosted run and a sandbox, including:

- thread and organization workspace links;
- the MCP endpoint and generated tool catalog;
- expiry, refresh, detach, and cleanup metadata.

The payload is illustrative, not a committed public API. The final design must
not make sandbox-global mutable state appear run-scoped when multiple runs can
use a sandbox concurrently.

## Requirements and risks

### Concurrency and ownership

An ephemeral Decopilot sandbox can be shared by multiple threads. Files such as
`.deco/.endpoint.json` and links such as `org/output` have a single
workspace-wide value, so concurrent runs can overwrite each other's context.
The follow-up must choose and enforce one ownership model:

- isolate derived state by run and make commands resolve through that run;
- serialize attachments and explicitly allow only one active run; or
- make all mutable context operation-scoped instead of changing global links.

Last-writer-wins behavior must not be accidental.

### Reliability

The hosted catalog sync introduced in PR #4638 is best-effort and
fire-and-forget. Run attachment should define:

- whether attachment is a readiness barrier before the first command;
- retry and acknowledgement semantics;
- idempotency across daemon restarts and sandbox reprovisioning;
- what remains usable when catalog refresh fails but an older catalog exists.

### Credential lifecycle

The endpoint file contains an authorization header. It is mode `0600` and
excluded from the generated catalog's git surface, but a complete lifecycle
also needs refresh before expiry, removal on detach or ownership change,
isolation between runs, and proof that credentials cannot enter commits or
artifacts.

## Migration sketch

1. Define the concurrency and state-isolation model.
2. Extract an internal daemon `attachRun` service that validates hosted run
   context and owns all run-derived materializers.
3. Have hosted sandbox provisioning/reuse invoke the authenticated attachment
   operation and observe its readiness result.
4. Move catalog sync and thread-link initialization behind that service.
5. Keep `/_sandbox/tools/sync` and per-operation thread headers as temporary
   compatibility paths, then remove them after the hosted caller migrates.
6. Add refresh, detach, expiry, and stale-run cleanup.

## Validation matrix

The refactor is complete only when black-box tests cover first hosted command,
sandbox reuse, daemon restart, reprovisioning, repeated attachment, lost-response
retry, the simultaneous-run policy, token refresh and expiry, detach cleanup,
and absence of credentials from git-visible files and artifacts.

## Non-goals

- Changing Studio Native's PTY-based coding-agent runtime.
- Rewriting sandbox providers or hosted run orchestration.
- Blocking the initial tool-catalog feature on this larger lifecycle refactor.
