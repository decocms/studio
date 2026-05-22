# Unify sandbox paths: flatten `link/` and route Claude Code through `ensureVm`

**Date:** 2026-05-22
**Status:** Approved, pending implementation plan
**Owners:** @tlgimenes

## Problem

Two unrelated-looking bugs share a root cause: the link daemon stores sandboxes under a namespaced subtree, and the `remote-cli` dispatch path (claude-code, codex) provisions its own sandbox keyed by `runId` instead of reusing the one VM_START already provisioned.

### Symptom 1 — confusing nested directory

The link daemon writes everything it owns under `<dataDir>/link/`:

- `<dataDir>/link/sandboxes/<handle>/` — sandbox workdirs (`apps/mesh/src/link-daemon/sandbox-provider.ts:151`)
- `<dataDir>/link/machine-id` — desktop identity file (`apps/mesh/src/link-daemon/machine-id.ts:18`)

The `link/` prefix was introduced when `<dataDir>` was assumed to be shared with other deco subsystems (postgres, NATS). It isn't — those live under a separate `<servicesDir>` (`apps/mesh/src/services/ensure-services.ts:273`). The prefix is dead namespacing.

### Symptom 2 — Claude Code runs in an empty sandbox

When the cluster dispatches a claude-code (or codex) stream to a desktop link, `resolveDispatchTarget` returns `kind: "remote-cli"` (`apps/mesh/src/links/resolve-dispatch-target.ts:74`). The dispatcher then calls `ensureRemoteCliSandbox(link, harnessInput.runId)` (`apps/mesh/src/api/routes/decopilot/dispatch-run.ts:830`), which:

- Uses `runId` (= thread UUID) as the sandbox handle.
- Sends no `repo` field — the link auto-creates an empty workdir at `<dataDir>/link/sandboxes/<runId>/`.

Meanwhile VM_START / `ensureVm` provisions the *real* sandbox at `<dataDir>/link/sandboxes/<computeHandle(SandboxId, branch, {hashLen:16})>/`, with the repo cloned. Claude Code's CLI subprocess, spawned with `APP_ROOT=<dataDir>/link/sandboxes/<runId>`, faithfully reports its cwd as `…/<runId>/repo` — a directory that exists but is empty.

Originally documented in `apps/mesh/src/harnesses/remote-dispatch.ts:163-170` as intentional ("ephemeral CLI runs operate on an empty workdir"), the assumption breaks for repo-linked agents — exactly the case the clonable-agent flow exercises.

## Goals

1. Move the link daemon's on-disk subtree out of `link/` so the directory layout matches what it actually is: the link daemon's data.
2. Make the `remote-cli` dispatch use the same sandbox that VM_START provisions, so Claude Code runs inside the cloned repo.

## Non-goals

- No migration tooling for the old `link/` path. Hard cutover; orphans are user-deletable.
- No changes to the `runId`-keyed run-cancellation semantics inside the daemon.
- No changes to docker / agent-sandbox providers' handle schemes.
- No `LinkRegistry` schema changes.

## Design

### Part 1 — Path move

Two on-disk renames, hard cutover (no migration code, no symlinks):

| Before | After |
|---|---|
| `<dataDir>/link/sandboxes/<handle>/` | `<dataDir>/sandboxes/<handle>/` |
| `<dataDir>/link/machine-id` | `<dataDir>/machine-id` |

**Code touches:**

- `apps/mesh/src/link-daemon/sandbox-provider.ts:151` — change `join(deps.dataDir, "link", "sandboxes", input.handle)` → `join(deps.dataDir, "sandboxes", input.handle)`.
- `apps/mesh/src/link-daemon/machine-id.ts:18` — change `join(dataDir, "link", "machine-id")` → `join(dataDir, "machine-id")`.
- Comments referencing `<dataDir>/link/sandboxes/...` in:
  - `apps/mesh/src/harnesses/remote-dispatch.ts:170`
  - `apps/mesh/src/cli/commands/dev.ts:127,245`
  - `packages/sandbox/daemon/git/branch-status.ts:120`
  - `packages/sandbox/daemon/git/branch-status.test.ts:151`
- Doc comment in `apps/mesh/src/link-daemon/machine-id.ts:3` ("lives at `<dataDir>/link/machine-id`").

**User impact:**

- Sandboxes under the old `~/deco/link/sandboxes/` become orphans after upgrade; the user's next session re-clones into `~/deco/sandboxes/`. Any uncommitted work in old sandboxes is recoverable by the user (`git status` in the old path) but the daemon won't reach those paths anymore.
- `~/deco/link/machine-id` becomes orphaned; the link generates a fresh ID on next start. The cluster's `LinkRegistry` row, keyed by OAuth userSub, overwrites its stored `machineId` at re-registration — no orphan row, no TTL wait.

**Tests to update:**

- `apps/mesh/src/link-daemon/sandbox-provider.test.ts` — expected workdir path.
- `apps/mesh/src/link-daemon/machine-id.test.ts` — expected file path.

### Part 2 — Dispatch unification

**Location:** `apps/mesh/src/api/routes/decopilot/dispatch-run.ts:828-842`.

**Today:**

```ts
if (target.kind === "remote-cli") {
  const { sandboxUrl } = await ensureRemoteCliSandbox(
    target.link,
    harnessInput.runId,
  );
  harnessChunks = remoteDispatch(harnessId, harnessInput, target.link, sandboxUrl);
}
```

**After:**

```ts
if (target.kind === "remote-cli") {
  const entry = await ensureVm(
    {
      virtualMcpId: input.agent.id,
      branch: input.branch ?? "ephemeral",
      sandboxProviderKind: "desktop",
    },
    ctx,
  );
  harnessChunks = remoteDispatch(
    harnessId,
    harnessInput,
    target.link,
    entry.previewUrl,
  );
}
```

**Why `ensureVm` is the right seam:**

- Already lazy and idempotent (`apps/mesh/src/tools/vm/start.ts:162`). Fast path returns the existing `VmMapEntry` if one exists for `(userId, branch, sandboxProviderKind)` — no spawn round-trip.
- Resolves the desktop provider bound to the user's link via `resolveSandboxProvider`, then `DesktopSandboxProvider.ensure({userId, projectRef}, {repo, branch, ...})` — same code path VM_START uses.
- Provider derives the handle via `computeHandle(sandboxId, branch, {hashLen: 16})` (`packages/sandbox/server/provider/desktop/runner.ts:106`), which is the deterministic, branch-aware identifier that already correctly addresses the repo sandbox.
- Tolerates `githubRepo === null` (`apps/mesh/src/tools/vm/start.ts:211-323`) for ephemeral threads — boots blank, no clone attempted.
- Writes the `VmMapEntry` to `vmMap` so subsequent VM tools and the UI's preview pane see the same sandbox.

**Deletions:**

- `ensureRemoteCliSandbox` in `apps/mesh/src/harnesses/remote-dispatch.ts:175-216`.
- Its import line in `apps/mesh/src/api/routes/decopilot/dispatch-run.ts:30`.
- Tests that target `ensureRemoteCliSandbox` directly in `apps/mesh/src/harnesses/remote-dispatch.test.ts`.

### Behavior changes (intentional)

1. **One sandbox per `(user, virtualMcpId, branch)`, not per run.** Every claude-code/codex run on the same branch reuses the same workdir. Per-run state (run registry, cancellation) stays keyed by `runId` inside the daemon (`apps/mesh/src/harnesses/remote-dispatch.ts:232` — `DELETE /_decopilot_vm/runs/<runId>` keeps working).

2. **Ephemeral threads share a sandbox per virtualMcp.** Branch defaults to `"ephemeral"` at the routes layer (`apps/mesh/src/api/routes/decopilot/routes.ts:434`). All ephemeral threads on the same virtualMcp share the handle `computeHandle({userId, projectRef: "agent:<orgId>:<vmcpId>:ephemeral"}, "ephemeral", {hashLen: 16})`. No repo state is at stake for ephemeral threads so the shared workdir is safe.

3. **`vmMap` is populated by dispatch.** First claude-code dispatch on a branch creates the `vmMap` entry. Consistent with how the always-on VM tools path already calls `ensureVm`.

### Risks

| Risk | Mitigation |
|---|---|
| `ensureVm` does more work than `ensureRemoteCliSandbox` on first call (env push, vmMap write, lockfile probe). | First dispatch was already paying this cost via VM_START; unifying collapses two trips into one. Subsequent dispatches hit the fast path (`apps/mesh/src/tools/vm/start.ts:196`). |
| Concurrent dispatch + VM_START on a fresh `(user, branch)` double-provisions. | `DesktopSandboxProvider.ensureSandbox` has inflight-promise dedup keyed by handle (`apps/mesh/src/link-daemon/sandbox-provider.ts:122-126`); both callers converge on the same daemon. |
| `ensureVm` reads/writes `vmMap`; dispatch's auth context differs from VM_START's. | `ensureVm` already inlines its own auth (`apps/mesh/src/tools/vm/start.ts:174-177`, deliberately skipping `ctx.access.check` for streaming turns) — fits dispatch unchanged. |
| Old-path orphan sandboxes silently accumulate disk usage. | Documented in commit message + release notes. Users can `rm -rf ~/deco/link` after upgrading. Janitor sweep is a follow-up. |

## Rollout

Single PR, two commits for review clarity:

1. **Commit A — Path move.** Mechanical rename in `sandbox-provider.ts:151` and `machine-id.ts:18`, plus comment/test updates. No behavior change beyond on-disk location.
2. **Commit B — Dispatch unification.** Swap `ensureRemoteCliSandbox` → `ensureVm` in `dispatch-run.ts`, delete the dead function and its tests, add a dispatch-run test that exercises the new `target.kind === "remote-cli"` branch through `ensureVm` and asserts the handle matches `computeHandle(...)`.

### Tests to update or add

- `apps/mesh/src/link-daemon/sandbox-provider.test.ts` — new expected workdir path.
- `apps/mesh/src/link-daemon/machine-id.test.ts` — new expected file path.
- `apps/mesh/src/links/dispatch-loopback.test.ts` — expect the `computeHandle` handle on the link's `POST /api/sandboxes`, not the runId.
- `apps/mesh/src/harnesses/remote-dispatch.test.ts` — drop the `ensureRemoteCliSandbox` cases.
- `apps/mesh/src/api/routes/decopilot/dispatch-run.ts` test surface — add a `target.kind === "remote-cli"` case that asserts `ensureVm` is invoked and `entry.previewUrl` is passed to `remoteDispatch`.

## Follow-ups (not blocking)

- Janitor task to GC orphaned `~/deco/link/` directories after first start under the new layout.
- Revisit ephemeral-thread sharing if users report cross-thread state bleed; the fallback is keying ephemeral handles by `threadId` instead of the synthetic `"ephemeral"` branch.
