# Agent Sandbox Provider Rename And Dispatch Target Cleanup

## Goal

Rename the sandbox provider kind value `"cluster"` to `"agent-sandbox"` and remove the extra `runsIn` dispatch dimension. The product model should have one execution dimension:

- `"agent-sandbox"`: the harness loop runs in Studio, and sandbox operations target the hosted agent-sandbox provider.
- `"user-desktop"`: the harness loop runs on the user's linked desktop for Decopilot, Claude Code, and Codex.

The cleanup should not rename control-plane concepts where "cluster" means the Studio server or remote control plane, such as `clusterBaseUrl`, link daemon cluster polling, or cluster ingest.

## Current Problem

The code currently uses `SandboxProviderKind = "cluster" | "user-desktop"` and separately models dispatch as `{ runsIn, sandbox }`. That creates a confusing middle state: `{ runsIn: "cluster", sandbox: "user-desktop" }`, which currently routes Decopilot on a user-desktop sandbox to run the loop in Studio while tunneling only sandbox tool calls to the desktop.

This contradicts the intended architecture. The daemon already registers `decopilotDesktopHarnessFactory`, and dispatch code has dormant Decopilot desktop wiring, but target resolution prevents that path from being used.

## Design

Use one target shape based on provider kind:

```ts
type DispatchTarget =
  | { sandboxProviderKind: "agent-sandbox" }
  | { sandboxProviderKind: "user-desktop"; link: LinkClaim };
```

`resolveDispatchTarget()` should:

- normalize legacy `"cluster"` inputs to `"agent-sandbox"` during the transition;
- return `"agent-sandbox"` for hosted execution;
- require an active link and harness capability for `"user-desktop"`;
- route Decopilot, Claude Code, and Codex identically for `"user-desktop"` by selecting desktop harness execution.

`dispatch-run.ts` should derive behavior from `target.sandboxProviderKind`:

- `"agent-sandbox"` calls `localDispatch(...)` in Studio;
- `"user-desktop"` builds the desktop provider, ensures or derives the desktop sandbox handle as appropriate, injects Decopilot `mcp.modelSecret` when `harnessId === "decopilot"`, and calls `remoteDispatch(...)`.

## Compatibility

Existing persisted rows and request payloads may still contain `"cluster"`. Reads should accept `"cluster"` as a legacy alias for `"agent-sandbox"`. Writes should use `"agent-sandbox"` going forward. A migration can update existing `sandbox_provider_kind` and `sandbox_runner_state` rows if needed, but runtime normalization should make the transition safe even before old local data is migrated.

## Scope

Included:

- provider kind types and schemas;
- target resolution;
- dispatch routing;
- UI mode mappings and tests;
- storage/runtime normalization for legacy `"cluster"` values;
- comments that refer specifically to the sandbox provider kind.

Excluded:

- renaming `clusterBaseUrl`, link daemon cluster connection terminology, cluster ingest, or other control-plane names where "cluster" still means Studio/the remote server.

## Testing

Add or update tests for:

- provider kind schema accepts `"agent-sandbox"` and normalizes legacy `"cluster"`;
- Decopilot + `"user-desktop"` resolves to desktop execution;
- Decopilot desktop dispatch receives a real MCP endpoint and `mcp.modelSecret`;
- Claude Code and Codex desktop dispatch still use the same remote path;
- agent-sandbox mode continues to run in Studio;
- UI option mapping uses `"agent-sandbox"` for hosted Decopilot.
