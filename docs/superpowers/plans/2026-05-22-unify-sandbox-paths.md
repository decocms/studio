# Unify sandbox paths Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Flatten the link daemon's `<dataDir>/link/` subtree to the top of `<dataDir>`, and unify the `remote-cli` dispatch path so claude-code/codex runs reuse the VM_START sandbox instead of provisioning a per-run empty workdir.

**Architecture:** Two independent commits in a single PR. Commit A is a mechanical path move — change two `join(...)` calls and update prose. Commit B replaces the call to `ensureRemoteCliSandbox(link, runId)` in `dispatch-run.ts` with `ensureVm({ virtualMcpId, branch, sandboxProviderKind: "desktop" }, ctx)`, deletes the dead helper, and wires the resulting `previewUrl` into `remoteDispatch`. The new dispatch logic is extracted into a small helper (`resolveRemoteCliSandboxUrl`) so it can be unit-tested in isolation.

**Tech Stack:** TypeScript, Bun test runner, Hono (for the link control plane), Kysely (for `vmMap` writes via `ensureVm`).

---

## Pre-flight

- [ ] **Step P1: Confirm clean working tree on the feature branch**

Run:
```bash
git status
git log -1 --oneline
```
Expected: clean tree on `tlgimenes/sandbox-path-mismatch` (or the worktree this plan executes in), with the spec commit `9f9d5250b` (or later) at HEAD.

- [ ] **Step P2: Establish a green baseline**

Run:
```bash
bun test apps/mesh/src/link-daemon/sandbox-provider.test.ts apps/mesh/src/link-daemon/machine-id.test.ts apps/mesh/src/harnesses/remote-dispatch.test.ts apps/mesh/src/links/dispatch-loopback.test.ts
```
Expected: all tests pass. If any fail before we change anything, stop and investigate — those failures aren't ours.

---

## Commit A — Path move

### Task A1: Move sandbox workdir out of `link/`

**Files:**
- Modify: `apps/mesh/src/link-daemon/sandbox-provider.ts:151`

- [ ] **Step 1: Edit the workdir path**

Change line 151 from:
```ts
    const workdir = join(deps.dataDir, "link", "sandboxes", input.handle);
```
to:
```ts
    const workdir = join(deps.dataDir, "sandboxes", input.handle);
```

- [ ] **Step 2: Type-check**

Run:
```bash
bun run --cwd=apps/mesh check
```
Expected: PASS (no type errors).

- [ ] **Step 3: Run the affected test**

Run:
```bash
bun test apps/mesh/src/link-daemon/sandbox-provider.test.ts
```
Expected: PASS. The existing tests use mocked spawnDaemon callbacks that don't assert the workdir path, so no test updates needed here.

### Task A2: Move machine-id out of `link/`

**Files:**
- Modify: `apps/mesh/src/link-daemon/machine-id.ts:3` (doc comment) and `:18` (path)

- [ ] **Step 1: Edit the doc comment**

Change line 3 from:
```ts
 * registration. It lives at `<dataDir>/link/machine-id` and is
```
to:
```ts
 * registration. It lives at `<dataDir>/machine-id` and is
```

- [ ] **Step 2: Edit the path**

Change line 18 from:
```ts
  return join(dataDir, "link", "machine-id");
```
to:
```ts
  return join(dataDir, "machine-id");
```

- [ ] **Step 3: Run the machine-id test**

Run:
```bash
bun test apps/mesh/src/link-daemon/machine-id.test.ts
```
Expected: PASS. The test uses a fresh tmpdir each run and asserts only the stability of the returned id (length 32, equal across calls), not the on-disk path. No test edits needed.

### Task A3: Update comments that reference the old path

**Files:**
- Modify: `apps/mesh/src/harnesses/remote-dispatch.ts:170`
- Modify: `apps/mesh/src/cli/commands/dev.ts:127,245`
- Modify: `packages/sandbox/daemon/git/branch-status.ts:120`
- Modify: `packages/sandbox/daemon/git/branch-status.test.ts:151`

These are documentation-only updates so future readers don't see paths that no longer exist on disk. They are mechanical search-and-replace edits, but each diff is shown here so the worker doesn't have to guess.

- [ ] **Step 1: `apps/mesh/src/harnesses/remote-dispatch.ts:170`**

This file's `ensureRemoteCliSandbox` is going to be deleted in Commit B; we still update its doc comment now so Commit A leaves the file internally consistent. Change line 170 from:
```ts
 * the link auto-creates at `<dataDir>/link/sandboxes/<handle>/`.
```
to:
```ts
 * the link auto-creates at `<dataDir>/sandboxes/<handle>/`.
```

- [ ] **Step 2: `apps/mesh/src/cli/commands/dev.ts:127`**

Change line 127 from:
```ts
  // mesh repo. Sandbox clones go into `<DATA_DIR>/link/sandboxes/<handle>/repo`;
```
to:
```ts
  // mesh repo. Sandbox clones go into `<DATA_DIR>/sandboxes/<handle>/repo`;
```

- [ ] **Step 3: `apps/mesh/src/cli/commands/dev.ts:245`**

Change line 245 from:
```ts
              // user repos into `<DATA_DIR>/link/sandboxes/<handle>/repo`;
```
to:
```ts
              // user repos into `<DATA_DIR>/sandboxes/<handle>/repo`;
```

- [ ] **Step 4: `packages/sandbox/daemon/git/branch-status.ts:120`**

Change line 120 from:
```ts
        // workspace tree containing link/sandboxes/<handle>/repo) can't
```
to:
```ts
        // workspace tree containing sandboxes/<handle>/repo) can't
```

- [ ] **Step 5: `packages/sandbox/daemon/git/branch-status.test.ts:151`**

Change line 151 from:
```ts
  // git worktree (e.g. host runner: <project>/link/sandboxes/<handle>/repo
```
to:
```ts
  // git worktree (e.g. host runner: <project>/sandboxes/<handle>/repo
```

- [ ] **Step 6: Sanity-grep for any stragglers**

Run:
```bash
git grep -n 'link/sandboxes\|link/machine-id' -- 'apps/' 'packages/'
```
Expected: empty output. If anything matches, update it to drop the `link/` prefix (or, for doc-aspirational paths in `apps/docs/`, leave it but note in commit message).

### Task A4: Verify Commit A is green and commit

- [ ] **Step 1: Type-check the whole workspace**

Run:
```bash
bun run check
```
Expected: PASS.

- [ ] **Step 2: Format**

Run:
```bash
bun run fmt
```
Expected: PASS. Re-stage any files Biome touched.

- [ ] **Step 3: Run the link-daemon and resolve-related tests**

Run:
```bash
bun test apps/mesh/src/link-daemon/ apps/mesh/src/links/ apps/mesh/src/harnesses/remote-dispatch.test.ts packages/sandbox/daemon/git/
```
Expected: PASS.

- [ ] **Step 4: Stage and commit**

Run:
```bash
git add apps/mesh/src/link-daemon/sandbox-provider.ts \
        apps/mesh/src/link-daemon/machine-id.ts \
        apps/mesh/src/harnesses/remote-dispatch.ts \
        apps/mesh/src/cli/commands/dev.ts \
        packages/sandbox/daemon/git/branch-status.ts \
        packages/sandbox/daemon/git/branch-status.test.ts
git commit -m "$(cat <<'EOF'
refactor(link-daemon): flatten <dataDir>/link/* to top-level <dataDir>

Moves the link daemon's on-disk subtree out of the `link/` namespace:
- `<dataDir>/link/sandboxes/<handle>/` → `<dataDir>/sandboxes/<handle>/`
- `<dataDir>/link/machine-id` → `<dataDir>/machine-id`

Hard cutover. Existing sandboxes under the old path become orphans on
upgrade; users can `rm -rf ~/deco/link` to reclaim disk. The old
machine-id is regenerated on next link start and the cluster's
LinkRegistry row (keyed by OAuth userSub) overwrites its stored
machineId at re-registration — no orphan row.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Commit B — Dispatch unification

### Task B1: Extract `resolveRemoteCliSandboxUrl` helper (with failing test)

**Files:**
- Modify: `apps/mesh/src/api/routes/decopilot/dispatch-run.ts` — add a small exported helper near the bottom of the file.
- Create: `apps/mesh/src/api/routes/decopilot/dispatch-sandbox.test.ts` — focused unit test for the helper.

The helper exists so we can unit-test the new dispatch behavior without standing up the full `dispatchRunAndWait` machinery. Its only job is to call `ensureVm` with the right inputs and surface `previewUrl` back to the caller.

- [ ] **Step 1: Write the failing test**

Create `apps/mesh/src/api/routes/decopilot/dispatch-sandbox.test.ts` with:

```ts
/**
 * Unit test for the helper that the remote-cli dispatch branch uses to
 * resolve which sandbox URL to talk to. The helper unifies with
 * `ensureVm` so claude-code/codex runs share the VM_START sandbox
 * instead of provisioning a per-run empty workdir.
 */
import { describe, expect, it, mock } from "bun:test";

// `ensureVm` lives in tools/vm/start; we mock the module so the test
// doesn't need to wire up storage, link registry, or the sandbox
// provider. The route file imports `ensureVm` from this path.
mock.module("@/tools/vm/start", () => ({
  ensureVm: async (
    input: {
      virtualMcpId: string;
      branch: string;
      sandboxProviderKind: "desktop";
    },
  ) => {
    ensureVmCalls.push(input);
    return {
      vmId: "sleek-flint-0000000000000000",
      previewUrl: "https://sleek-flint-0000000000000000.deco.host",
      sandboxUrl: "https://sleek-flint-0000000000000000.deco.host",
      sandboxProviderKind: "desktop" as const,
      createdAt: 0,
      startedWith: { packageManager: null, port: null, path: null },
    };
  },
}));

const ensureVmCalls: Array<{
  virtualMcpId: string;
  branch: string;
  sandboxProviderKind: string;
}> = [];

const { resolveRemoteCliSandboxUrl } = await import("./dispatch-run");

describe("resolveRemoteCliSandboxUrl", () => {
  it("calls ensureVm with the agent id, branch, and desktop kind", async () => {
    ensureVmCalls.length = 0;
    const sandboxUrl = await resolveRemoteCliSandboxUrl(
      { agent: { id: "vm-1" }, branch: "deco/sleek-flint" },
      // The helper passes ctx straight to ensureVm; the mock ignores it.
      {} as never,
    );
    expect(ensureVmCalls).toEqual([
      {
        virtualMcpId: "vm-1",
        branch: "deco/sleek-flint",
        sandboxProviderKind: "desktop",
      },
    ]);
    expect(sandboxUrl).toBe(
      "https://sleek-flint-0000000000000000.deco.host",
    );
  });

  it("falls back to 'ephemeral' when branch is missing", async () => {
    ensureVmCalls.length = 0;
    await resolveRemoteCliSandboxUrl(
      { agent: { id: "vm-2" }, branch: null },
      {} as never,
    );
    expect(ensureVmCalls[0]?.branch).toBe("ephemeral");
  });

  it("falls back to 'ephemeral' when branch is undefined", async () => {
    ensureVmCalls.length = 0;
    await resolveRemoteCliSandboxUrl(
      { agent: { id: "vm-3" } },
      {} as never,
    );
    expect(ensureVmCalls[0]?.branch).toBe("ephemeral");
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run:
```bash
bun test apps/mesh/src/api/routes/decopilot/dispatch-sandbox.test.ts
```
Expected: FAIL with `SyntaxError: The requested module './dispatch-run' does not provide an export named 'resolveRemoteCliSandboxUrl'` (or similar import-resolution error).

- [ ] **Step 3: Implement the helper**

Open `apps/mesh/src/api/routes/decopilot/dispatch-run.ts`.

First, replace the `ensureRemoteCliSandbox` import on lines 29-32:

```ts
import {
  ensureRemoteCliSandbox,
  remoteDispatch,
} from "@/harnesses/remote-dispatch";
```

with:

```ts
import { remoteDispatch } from "@/harnesses/remote-dispatch";
import { ensureVm } from "@/tools/vm/start";
```

Then add the helper as a new exported function at the bottom of the file (after the existing `dispatchRunAndWait` definition and any helpers; pick a location that matches local style — usually near the other small exports). Append:

```ts
/**
 * Resolve the sandbox URL the cluster should dispatch a `remote-cli`
 * harness stream to. Calls `ensureVm` (lazy/idempotent — fast path
 * returns the existing entry, slow path provisions through the
 * desktop sandbox provider) so the resulting sandbox is the same one
 * VM_START / the always-on VM tools use. Returns the daemon's
 * `previewUrl`, which is the per-handle tunnel URL the cluster
 * already talks to directly.
 *
 * Branch defaults to `"ephemeral"` to match
 * `apps/mesh/src/api/routes/decopilot/routes.ts:434` — threads
 * without a connected repo share one sandbox per virtualMcp under
 * that synthetic branch.
 *
 * Exported so the unification can be unit-tested without standing up
 * the full `dispatchRunAndWait` machinery.
 */
export async function resolveRemoteCliSandboxUrl(
  input: { agent: { id: string }; branch?: string | null },
  ctx: MeshContext,
): Promise<string> {
  const entry = await ensureVm(
    {
      virtualMcpId: input.agent.id,
      branch: input.branch ?? "ephemeral",
      sandboxProviderKind: "desktop",
    },
    ctx,
  );
  return entry.previewUrl;
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run:
```bash
bun test apps/mesh/src/api/routes/decopilot/dispatch-sandbox.test.ts
```
Expected: PASS — all three cases (`branch given`, `branch null`, `branch undefined`).

### Task B2: Swap the dispatch-run remote-cli branch to use the helper

**Files:**
- Modify: `apps/mesh/src/api/routes/decopilot/dispatch-run.ts:828-842` (the `if (target.kind === "remote-cli")` block)

- [ ] **Step 1: Replace the block**

Locate the existing block (around lines 828-842):

```ts
        let harnessChunks;
        if (target.kind === "remote-cli") {
          const { sandboxUrl } = await ensureRemoteCliSandbox(
            target.link,
            harnessInput.runId,
          );
          harnessChunks = remoteDispatch(
            harnessId,
            harnessInput,
            target.link,
            sandboxUrl,
          );
        } else {
          harnessChunks = localDispatch(harnessId, harnessInput, ctx);
        }
```

Replace with:

```ts
        let harnessChunks;
        if (target.kind === "remote-cli") {
          // Unify with VM_START: resolve the sandbox via `ensureVm` so
          // claude-code/codex runs share the workdir VM_START already
          // provisioned (cloned repo + env + lockfile probe). Falls
          // through to a blank sandbox for ephemeral threads. See
          // `resolveRemoteCliSandboxUrl` below for why the helper
          // exists.
          const sandboxUrl = await resolveRemoteCliSandboxUrl(
            { agent: input.agent, branch: input.branch },
            ctx,
          );
          harnessChunks = remoteDispatch(
            harnessId,
            harnessInput,
            target.link,
            sandboxUrl,
          );
        } else {
          harnessChunks = localDispatch(harnessId, harnessInput, ctx);
        }
```

- [ ] **Step 2: Type-check**

Run:
```bash
bun run --cwd=apps/mesh check
```
Expected: PASS.

- [ ] **Step 3: Run the new helper test plus the existing dispatch-loopback test**

Run:
```bash
bun test apps/mesh/src/api/routes/decopilot/dispatch-sandbox.test.ts apps/mesh/src/links/dispatch-loopback.test.ts apps/mesh/src/harnesses/remote-dispatch.test.ts
```
Expected: PASS. The loopback test still exercises `remoteDispatch` against a single tunnelUrl, which is unaffected; the remote-dispatch test tests only `remoteDispatch`/`parseSSEStream` and never depended on `ensureRemoteCliSandbox`.

### Task B3: Delete the dead `ensureRemoteCliSandbox`

**Files:**
- Modify: `apps/mesh/src/harnesses/remote-dispatch.ts` — delete the function and its preceding doc block.

- [ ] **Step 1: Delete the function and its doc block**

In `apps/mesh/src/harnesses/remote-dispatch.ts`, locate the block spanning lines 147-216:

```ts
/**
 * Subset of `LinkEntry` actually needed by `remoteDispatch`. Accepting
 * the smaller shape makes test fakes cheaper to construct.
 */
export type RemoteDispatchLink = Pick<LinkEntry, "tunnelUrl" | "linkSecret">;

/**
 * Ensure the desktop link has a sandbox registered at `handle` before the
 * cluster fires `remoteDispatch`. The link's `POST /api/sandboxes`
 * ...
 * Idempotent on the link side — repeated POSTs with the same handle
 * return the existing sandbox unchanged.
 */
export async function ensureRemoteCliSandbox(
  link: RemoteDispatchLink,
  handle: string,
  deps: RemoteDispatchDeps = {},
): Promise<{ sandboxUrl: string }> {
  // ... full function body ...
}
```

KEEP the `RemoteDispatchLink` type (still used by `remoteDispatch`). DELETE only the doc block immediately preceding `ensureRemoteCliSandbox` AND the function itself (the contiguous range from the start of `/**\n * Ensure the desktop link has...` through the closing `}` of the function — lines 153-216 in the current file).

After the deletion, the file should jump straight from the `RemoteDispatchLink` type definition into the `remoteDispatch` function (the next existing export at line 218).

- [ ] **Step 2: Verify no lingering callers**

Run:
```bash
git grep -n 'ensureRemoteCliSandbox' -- apps/ packages/
```
Expected: empty output. If anything matches, fix the call site (it should already have been swapped in Task B2).

- [ ] **Step 3: Type-check**

Run:
```bash
bun run --cwd=apps/mesh check
```
Expected: PASS.

- [ ] **Step 4: Run the targeted test suite**

Run:
```bash
bun test apps/mesh/src/harnesses/remote-dispatch.test.ts apps/mesh/src/api/routes/decopilot/dispatch-sandbox.test.ts apps/mesh/src/links/dispatch-loopback.test.ts
```
Expected: PASS.

### Task B4: Verify the whole change set, format, and commit

- [ ] **Step 1: Run the full app test suite (focused subset)**

Run:
```bash
bun test apps/mesh/src/link-daemon/ apps/mesh/src/links/ apps/mesh/src/harnesses/ apps/mesh/src/api/routes/decopilot/ apps/mesh/src/tools/vm/ apps/mesh/src/sandbox/
```
Expected: PASS.

- [ ] **Step 2: Format**

Run:
```bash
bun run fmt
```
Expected: PASS. Re-stage if Biome touched anything.

- [ ] **Step 3: Lint**

Run:
```bash
bun run lint
```
Expected: PASS.

- [ ] **Step 4: Stage and commit**

Run:
```bash
git add apps/mesh/src/api/routes/decopilot/dispatch-run.ts \
        apps/mesh/src/api/routes/decopilot/dispatch-sandbox.test.ts \
        apps/mesh/src/harnesses/remote-dispatch.ts
git commit -m "$(cat <<'EOF'
feat(decopilot): unify remote-cli dispatch with VM_START sandbox

Replaces the per-runId `ensureRemoteCliSandbox(link, runId)` call in
dispatch-run with `ensureVm({virtualMcpId, branch, sandboxProviderKind:
"desktop"}, ctx)` so claude-code/codex runs reuse the same sandbox
VM_START provisions — cloned repo, env, lockfile probe and all.

Behavior changes (intentional):
- One sandbox per (user, virtualMcpId, branch) instead of one per run;
  per-run state inside the daemon stays runId-keyed (cancellation via
  DELETE /_decopilot_vm/runs/<runId> is unchanged).
- Ephemeral threads (no connected repo) share a sandbox per virtualMcp
  under the synthetic branch "ephemeral".
- First claude-code dispatch on a branch now creates the vmMap entry.

`ensureRemoteCliSandbox` is deleted; the dispatch logic is extracted
into `resolveRemoteCliSandboxUrl` so it can be unit-tested in isolation.

Fixes the "Claude Code reports a UUID-named cwd that doesn't have the
repo" bug from the v3 thread on the clonable-agent flow.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Wrap-up

- [ ] **Step W1: Run the full test suite one more time**

Run:
```bash
bun test
```
Expected: PASS (or no regressions vs. the pre-flight baseline). If there are pre-existing flaky tests unrelated to this change, note them in the PR description.

- [ ] **Step W2: Confirm the on-disk paths line up locally**

If you have a running `decocms link` against a fresh `DATA_DIR`, restart it and verify:
```bash
DATA_DIR=/tmp/deco-test-$(date +%s) bunx --cwd apps/mesh ./dist/cli.js link --no-tunnel &
# wait for it to register
sleep 5
ls "$DATA_DIR"
```
Expected: `machine-id` and (after a sandbox spawn) `sandboxes/` directly under `$DATA_DIR`; no `link/` subdirectory.

This is a smoke test, not a CI gate — skip if you don't have a local link binary handy.

- [ ] **Step W3: Push and open PR**

Run:
```bash
git push -u origin tlgimenes/sandbox-path-mismatch
gh pr create --base main --title "Flatten <dataDir>/link/* and unify Claude Code dispatch with VM_START" --body "$(cat <<'EOF'
## Summary

- Moves `<dataDir>/link/sandboxes/<handle>/` to `<dataDir>/sandboxes/<handle>/` and `<dataDir>/link/machine-id` to `<dataDir>/machine-id`. Hard cutover, no migration.
- Routes the `remote-cli` dispatch path (claude-code, codex) through `ensureVm` so runs share the sandbox VM_START provisioned, instead of getting a per-runId empty workdir.

## Test plan

- [ ] `bun test apps/mesh/src/link-daemon/ apps/mesh/src/links/ apps/mesh/src/harnesses/ apps/mesh/src/api/routes/decopilot/` passes locally.
- [ ] Manual: spin up `decocms link` against a fresh `DATA_DIR`, start a thread on a clonable agent, verify Claude Code reports its cwd as `<DATA_DIR>/sandboxes/<computeHandle>/repo` and the repo is checked out there.

See `docs/superpowers/specs/2026-05-22-unify-sandbox-paths-design.md` for the design notes.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```
Expected: the gh CLI prints a PR URL. Don't merge — leave it for review.

---

## Self-review checklist (for the implementer)

Before requesting review, verify:

- [ ] `git grep -n 'link/sandboxes\|link/machine-id'` returns no hits under `apps/` or `packages/`.
- [ ] `git grep -n 'ensureRemoteCliSandbox'` returns no hits anywhere.
- [ ] The new `resolveRemoteCliSandboxUrl` is exported AND the new test file imports it via the same path `dispatch-run.ts` is at.
- [ ] `bun run check`, `bun run lint`, `bun run fmt:check` all pass.
- [ ] The two commits are independently reviewable: Commit A's diff touches only paths/comments, Commit B's diff touches only dispatch-run + remote-dispatch + the new test file.
