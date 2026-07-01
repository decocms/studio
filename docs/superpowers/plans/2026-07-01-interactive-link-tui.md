# Interactive `deco link` TUI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `deco link` Ink table interactive — arrow-key row selection with `s` (stop), `d` (delete branch locally, unmounting NFS/FUSE first), and `o` (open preview URL).

**Architecture:** The TUI and the link daemon run in the **same process** (`link.ts` calls `render()` then `startLinkDaemon()`), so actions are plain async function calls, not IPC. Interactive state lives in the existing external store (`link-store.ts`) alongside a set of `actions` supplied by the daemon after it starts. All decision logic (keymap → intent, selection math, confirm text, delete orchestration, file purge) is extracted into small pure/DI modules that are unit-tested; the Ink view (`link-app.tsx`) is thin glue over them.

**Tech Stack:** TypeScript, Bun (`bun:sqlite`, `bun:test`), Ink 6 (React for terminals), `@decocms/sandbox` (workspace package).

## Global Constraints

- **Unit tests** use `bun:test`, pure logic only — no mocks, no `mock.module`, no stubbed `StudioContext`, no fake `fetch`. Dependency injection of plain fakes is allowed (matches `user-desktop-provider.test.ts`). (`TESTING.md`)
- **No `useEffect`** (`plugins/ban-use-effect.js`) and **no `useMemo`/`useCallback`/`memo`** (`plugins/ban-memoization.js`). Ink's `useInput`/`useApp` are allowed.
- **Formatting:** Biome — two-space indent, double quotes. Run `bun run fmt` before every commit.
- **Filenames** in this area are kebab-case (matches existing `link-app.tsx`, `link-store.ts`).
- **Async primitives** come from `@decocms/std` — never hand-roll sleep/retry/backoff.
- `d` is **local filesystem only** — no remote branch/repo/project mutation.
- Verify each task with `bun test <file>` and, for tasks touching cross-file types, `bun run check`.

---

## File Structure

**Create:**
- `packages/sandbox/daemon/org-fs/detach-mount.ts` — extracted `detachMount` (shared, zero-dep).
- `apps/mesh/src/link-daemon/purge-sandbox.ts` — unmount-then-`rm` a sandbox dir (DI for tests).
- `apps/mesh/src/link-daemon/purge-sandbox.test.ts`
- `apps/mesh/src/link-daemon/sandbox-actions.ts` — `createSandboxActions` (stop/remove/inspect over provider+registry).
- `apps/mesh/src/link-daemon/sandbox-actions.test.ts`
- `apps/mesh/src/cli/link-selection.ts` — pure selection math.
- `apps/mesh/src/cli/link-selection.test.ts`
- `apps/mesh/src/cli/link-keymap.ts` — pure key → intent.
- `apps/mesh/src/cli/link-keymap.test.ts`
- `apps/mesh/src/cli/link-confirm.ts` — `PendingConfirm` type + `formatConfirm`.
- `apps/mesh/src/cli/link-confirm.test.ts`
- `apps/mesh/src/cli/open-url.ts` — `resolveOpenCommand` + `openPreviewUrl`.
- `apps/mesh/src/cli/open-url.test.ts`
- `apps/mesh/src/cli/link-dispatch.ts` — `dispatchIntent` (intent → store setters + actions).
- `apps/mesh/src/cli/link-dispatch.test.ts`

**Modify:**
- `packages/sandbox/daemon/org-fs/mounter.ts` — import + re-export `detachMount` from the new file.
- `packages/sandbox/package.json` — add `./org-fs/detach-mount` export.
- `apps/mesh/src/cli/link-sandbox-registry.ts` — add `delete(handle)` + `inspect(handle)` + `SandboxInspection`.
- `apps/mesh/src/cli/link-sandbox-registry.test.ts` — cases for the two new methods.
- `apps/mesh/src/link-daemon/index.ts` — extend `LinkDaemonHandle`, wire `createSandboxActions`.
- `apps/mesh/src/cli/link-store.ts` — add `selectedHandle`/`pendingConfirm`/`actionError`/`actions` + setters + `removeSandboxRow` + `LinkActions`.
- `apps/mesh/src/cli/link-store.test.ts` — cases for the new setters.
- `apps/mesh/src/cli/link-app.tsx` — highlight, confirm line, footer, legend, `useInput`.
- `apps/mesh/src/cli/commands/link.ts` — call `setLinkActions(...)` after `startLinkDaemon`.

---

## Task 1: Extract `detachMount` to a shared module

**Files:**
- Create: `packages/sandbox/daemon/org-fs/detach-mount.ts`
- Modify: `packages/sandbox/daemon/org-fs/mounter.ts:111-137` (remove local def), `mounter.ts:17` (imports)
- Modify: `packages/sandbox/package.json:12-23` (exports map)

**Interfaces:**
- Produces: `detachMount(mountPath: string, isMac: boolean): void` importable via `@decocms/sandbox/org-fs/detach-mount`. Behavior unchanged.

- [ ] **Step 1: Create the shared module** (move the function verbatim from `mounter.ts`)

```ts
// packages/sandbox/daemon/org-fs/detach-mount.ts
/**
 * Force-detach whatever is mounted at `mountPath` (best-effort, never throws).
 * Used both to tear down our own mount and to reclaim a stale ghost left by a
 * previously-killed session before mounting fresh. On a path that isn't a mount
 * point every command exits non-zero and we simply move on.
 */
export function detachMount(mountPath: string, isMac: boolean): void {
  // NFS + FUSE both unmount via `umount`; on Linux `fusermount -u` is the
  // unprivileged path, so try it first there.
  const cmds: string[][] = isMac
    ? [["umount", "-f", mountPath]]
    : [
        ["fusermount", "-u", mountPath],
        ["umount", mountPath],
      ];
  for (const cmd of cmds) {
    // `umount -f` is the non-blocking force path, but bound it anyway: this
    // runs on every mount (reclaim) and at shutdown, and a wedged kernel
    // unmount must never hang the daemon.
    const p = Bun.spawnSync(cmd, {
      stdout: "ignore",
      stderr: "ignore",
      timeout: 5000,
    });
    if (p.exitCode === 0) break;
  }
}
```

- [ ] **Step 2: Replace the definition in `mounter.ts` with a re-export**

Delete the entire `export function detachMount(...) { ... }` block (currently `mounter.ts:111-137`) and add near the top imports (around `mounter.ts:33-34`):

```ts
import { detachMount } from "./detach-mount";

export { detachMount } from "./detach-mount";
```

The internal callers (`mounter.ts` `mount()` reclaim and `unmount()`) and `entry.ts` (which imports `{ createRcloneMounter, detachMount } from "./org-fs/mounter"`) keep working unchanged.

- [ ] **Step 3: Add the package subpath export**

In `packages/sandbox/package.json`, inside `"exports"`, add (keep alphabetical-ish with the other `./` entries):

```json
    "./org-fs/detach-mount": "./daemon/org-fs/detach-mount.ts",
```

- [ ] **Step 4: Verify no behavior change**

Run: `bun test packages/sandbox/daemon/org-fs/mounter.test.ts`
Expected: PASS (unchanged behavior).

Run: `bun run check`
Expected: no type errors.

- [ ] **Step 5: Commit**

```bash
bun run fmt
git add packages/sandbox/daemon/org-fs/detach-mount.ts packages/sandbox/daemon/org-fs/mounter.ts packages/sandbox/package.json
git commit -m "refactor(sandbox): extract detachMount to shared module"
```

---

## Task 2: `purgeSandboxFiles` — unmount then remove

**Files:**
- Create: `apps/mesh/src/link-daemon/purge-sandbox.ts`
- Test: `apps/mesh/src/link-daemon/purge-sandbox.test.ts`

**Interfaces:**
- Consumes: `detachMount` from `@decocms/sandbox/org-fs/detach-mount` (Task 1).
- Produces:
  ```ts
  interface PurgeSandboxDeps {
    detach?: (mountPath: string) => void;
    exists?: (path: string) => boolean;
    readdir?: (dir: string) => string[];
    rm?: (path: string) => void;
  }
  function purgeSandboxFiles(sandboxPath: string, deps?: PurgeSandboxDeps): void
  ```

- [ ] **Step 1: Write the failing test**

```ts
// apps/mesh/src/link-daemon/purge-sandbox.test.ts
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { purgeSandboxFiles } from "./purge-sandbox";

function sandboxWithVolumes(volumes: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "deco-purge-"));
  for (const v of volumes) {
    mkdirSync(join(root, "org", v), { recursive: true });
  }
  return root;
}

describe("purgeSandboxFiles", () => {
  it("detaches each direct child of org/ before removing the sandbox", () => {
    const root = sandboxWithVolumes(["vol-a", "vol-b"]);
    const detached: string[] = [];
    const removed: string[] = [];

    purgeSandboxFiles(root, {
      detach: (p) => detached.push(p),
      rm: (p) => removed.push(p),
    });

    expect(detached.sort()).toEqual(
      [join(root, "org", "vol-a"), join(root, "org", "vol-b")].sort(),
    );
    expect(removed).toEqual([root]);
  });

  it("removes the sandbox even when there is no org/ dir", () => {
    const root = mkdtempSync(join(tmpdir(), "deco-purge-"));
    const detached: string[] = [];
    const removed: string[] = [];

    purgeSandboxFiles(root, {
      detach: (p) => detached.push(p),
      rm: (p) => removed.push(p),
    });

    expect(detached).toEqual([]);
    expect(removed).toEqual([root]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/mesh/src/link-daemon/purge-sandbox.test.ts`
Expected: FAIL — `Cannot find module "./purge-sandbox"`.

- [ ] **Step 3: Write the implementation**

```ts
// apps/mesh/src/link-daemon/purge-sandbox.ts
/**
 * Delete a link sandbox directory from disk, unmounting any org-fs volumes
 * first so `rm` can't hang on a live (or ghost) NFS/FUSE mount nested at
 * `<sandboxPath>/org/<volume>`. All steps are injectable for tests.
 */
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { detachMount } from "@decocms/sandbox/org-fs/detach-mount";

export interface PurgeSandboxDeps {
  detach?: (mountPath: string) => void;
  exists?: (path: string) => boolean;
  readdir?: (dir: string) => string[];
  rm?: (path: string) => void;
}

const defaultDetach = (mountPath: string): void =>
  detachMount(mountPath, process.platform === "darwin");

export function purgeSandboxFiles(
  sandboxPath: string,
  deps: PurgeSandboxDeps = {},
): void {
  const detach = deps.detach ?? defaultDetach;
  const exists = deps.exists ?? existsSync;
  const readdir = deps.readdir ?? ((dir) => readdirSync(dir));
  const rm = deps.rm ?? ((path) => rmSync(path, { recursive: true, force: true }));

  const orgDir = join(sandboxPath, "org");
  if (exists(orgDir)) {
    for (const child of readdir(orgDir)) {
      detach(join(orgDir, child));
    }
  }
  rm(sandboxPath);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/mesh/src/link-daemon/purge-sandbox.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
bun run fmt
git add apps/mesh/src/link-daemon/purge-sandbox.ts apps/mesh/src/link-daemon/purge-sandbox.test.ts
git commit -m "feat(link): purgeSandboxFiles unmounts org volumes before rm"
```

---

## Task 3: Registry `delete` + `inspect`

**Files:**
- Modify: `apps/mesh/src/cli/link-sandbox-registry.ts` (interface `:67`, statements near `:351`, object literal near `:376`)
- Test: `apps/mesh/src/cli/link-sandbox-registry.test.ts`

**Interfaces:**
- Produces (add to exported `LinkSandboxRegistry`):
  ```ts
  delete(handle: string): void;
  inspect(handle: string): SandboxInspection | null;
  ```
  and a new exported type:
  ```ts
  interface SandboxInspection {
    handle: string;
    branch: string | null;
    sandboxPath: string;
    dirtyCount: number;      // count of `git status --porcelain` lines; 0 if clean/unknown
    merged: boolean | null;  // null if undeterminable
  }
  ```

- [ ] **Step 1: Write the failing tests** (append to the existing test file)

```ts
// apps/mesh/src/cli/link-sandbox-registry.test.ts — add these cases.
// Reuses the file's existing `tempDir()`, `openRegistry()`, and async `runGit()` helpers.

describe("delete", () => {
  it("removes a single row", () => {
    const reg = openRegistry(registryPathForDataDir(tempDir()));
    reg.upsert({ handle: "h1", status: "stopped", sandboxPath: "/tmp/h1" });
    reg.upsert({ handle: "h2", status: "stopped", sandboxPath: "/tmp/h2" });

    reg.delete("h1");

    expect(reg.list().map((r) => r.handle)).toEqual(["h2"]);
  });
});

describe("inspect", () => {
  it("returns null for an unknown handle", () => {
    const reg = openRegistry(registryPathForDataDir(tempDir()));
    expect(reg.inspect("nope")).toBeNull();
  });

  it("reports dirty count and merged=false for an unmerged dirty worktree", async () => {
    const data = tempDir();
    const work = join(data, "sandboxes", "h1");
    mkdirSync(work, { recursive: true });
    await runGit(work, ["init", "-b", "main"]);
    await runGit(work, ["config", "user.email", "t@t.co"]);
    await runGit(work, ["config", "user.name", "t"]);
    writeFileSync(join(work, "a.txt"), "1");
    await runGit(work, ["add", "."]);
    await runGit(work, ["commit", "-m", "init"]);
    await runGit(work, ["checkout", "-b", "feature"]);
    writeFileSync(join(work, "b.txt"), "2");
    await runGit(work, ["add", "."]);
    await runGit(work, ["commit", "-m", "feat"]);
    writeFileSync(join(work, "c.txt"), "uncommitted"); // 1 dirty file

    const reg = openRegistry(registryPathForDataDir(data));
    reg.upsert({
      handle: "h1",
      status: "ready",
      sandboxPath: work,
      branch: "feature",
    });

    const info = reg.inspect("h1");
    expect(info?.branch).toBe("feature");
    expect(info?.sandboxPath).toBe(work);
    expect(info?.dirtyCount).toBe(1);
    expect(info?.merged).toBe(false);
  });
});
```

Ensure the test file imports what these cases use (add if missing): `mkdirSync`, `writeFileSync` from `node:fs`, `join` from `node:path`, and `SandboxInspection` is not needed in the test (structural checks only).

- [ ] **Step 2: Run to verify failure**

Run: `bun test apps/mesh/src/cli/link-sandbox-registry.test.ts`
Expected: FAIL — `reg.delete is not a function` / `reg.inspect is not a function`.

- [ ] **Step 3: Add the type and interface members**

In `link-sandbox-registry.ts`, after the `LinkSandboxRecord`/status types (near the top exports), add:

```ts
export interface SandboxInspection {
  handle: string;
  branch: string | null;
  sandboxPath: string;
  dirtyCount: number;
  merged: boolean | null;
}
```

Extend the `LinkSandboxRegistry` interface (currently `:67-73`):

```ts
export interface LinkSandboxRegistry {
  upsert(row: LinkSandboxUpsert): void;
  list(): LinkSandboxRecord[];
  reconcile(): LinkSandboxRecord[];
  prune(options: LinkSandboxPruneOptions): LinkSandboxPruneResult;
  delete(handle: string): void;
  inspect(handle: string): SandboxInspection | null;
  close(): void;
}
```

- [ ] **Step 4: Add a get-by-handle statement**

Next to `deleteStmt` (near `:351`), add:

```ts
  const getStmt = db.query(`
    SELECT * FROM link_sandboxes WHERE handle = $handle
  `);
```

- [ ] **Step 5: Implement `delete` and `inspect` in the returned object**

In the object returned by `openLinkSandboxRegistry` (the `return { upsert, ... }` block near `:376`), add these methods (e.g. right after `prune`):

```ts
    delete(handle) {
      deleteStmt.run({ $handle: handle });
    },
    inspect(handle) {
      const row = getStmt.get({ $handle: handle }) as LinkSandboxDbRow | null;
      if (row === null) return null;
      const rec = toRecord(row);
      let dirtyCount = 0;
      let merged: boolean | null = null;
      if (
        existsSync(rec.sandboxPath) &&
        runGit(rec.sandboxPath, ["rev-parse", "--is-inside-work-tree"]).ok
      ) {
        const status = runGit(rec.sandboxPath, ["status", "--porcelain"]);
        if (status.ok) {
          const trimmed = status.stdout.trim();
          dirtyCount = trimmed === "" ? 0 : trimmed.split("\n").length;
        }
        if (rec.branch !== null && rec.branch.trim() !== "") {
          merged = branchIsMergedIntoDefault(rec.sandboxPath, rec.branch);
        }
      }
      return {
        handle: rec.handle,
        branch: rec.branch,
        sandboxPath: rec.sandboxPath,
        dirtyCount,
        merged,
      };
    },
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test apps/mesh/src/cli/link-sandbox-registry.test.ts`
Expected: PASS (existing + new cases).

- [ ] **Step 7: Commit**

```bash
bun run fmt
git add apps/mesh/src/cli/link-sandbox-registry.ts apps/mesh/src/cli/link-sandbox-registry.test.ts
git commit -m "feat(link): registry delete() and inspect() for a single handle"
```

---

## Task 4: `createSandboxActions` + daemon wiring

**Files:**
- Create: `apps/mesh/src/link-daemon/sandbox-actions.ts`
- Test: `apps/mesh/src/link-daemon/sandbox-actions.test.ts`
- Modify: `apps/mesh/src/link-daemon/index.ts` (`LinkDaemonHandle` `:84-87`, wiring + `return` `:366`)

**Interfaces:**
- Consumes: `purgeSandboxFiles` (Task 2); `SandboxInspection`, `LinkSandboxRegistry` (Task 3); `DesktopSandboxProvider` (`user-desktop-provider.ts`).
- Produces:
  ```ts
  interface SandboxActions {
    stopSandbox(handle: string): Promise<void>;
    removeSandbox(handle: string): Promise<{ ok: true } | { ok: false; error: string }>;
    inspectSandbox(handle: string): SandboxInspection | null;
  }
  function createSandboxActions(deps: SandboxActionsDeps): SandboxActions
  ```
  These same three signatures are added to `LinkDaemonHandle`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/mesh/src/link-daemon/sandbox-actions.test.ts
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { openLinkSandboxRegistry } from "../cli/link-sandbox-registry";
import { createSandboxActions } from "./sandbox-actions";

function fakeProvider(opts: { hasHandleAfterDelete: boolean }) {
  const calls: string[] = [];
  return {
    calls,
    deleteSandbox: async (handle: string) => {
      calls.push(handle);
    },
    hasHandle: (_handle: string) => opts.hasHandleAfterDelete,
  };
}

function memRegistryWithRow(handle: string, sandboxPath: string) {
  const reg = openLinkSandboxRegistry({ path: ":memory:" });
  reg.upsert({ handle, status: "stopped", sandboxPath });
  return reg;
}

describe("createSandboxActions.removeSandbox", () => {
  it("stops, purges, and drops the row on success", async () => {
    const provider = fakeProvider({ hasHandleAfterDelete: false });
    const reg = memRegistryWithRow("h1", "/data/sandboxes/h1");
    const purged: string[] = [];

    const actions = createSandboxActions({
      provider,
      registry: reg,
      dataDir: "/data",
      purge: (p) => purged.push(p),
    });

    const res = await actions.removeSandbox("h1");

    expect(res).toEqual({ ok: true });
    expect(provider.calls).toEqual(["h1"]);
    expect(purged).toEqual(["/data/sandboxes/h1"]);
    expect(reg.list()).toEqual([]);
  });

  it("refuses (no purge, row kept) when a run is still in flight", async () => {
    const provider = fakeProvider({ hasHandleAfterDelete: true });
    const reg = memRegistryWithRow("h1", "/data/sandboxes/h1");
    const purged: string[] = [];

    const actions = createSandboxActions({
      provider,
      registry: reg,
      dataDir: "/data",
      purge: (p) => purged.push(p),
    });

    const res = await actions.removeSandbox("h1");

    expect(res).toEqual({ ok: false, error: "Can't delete — run in progress" });
    expect(purged).toEqual([]);
    expect(reg.list().map((r) => r.handle)).toEqual(["h1"]);
  });

  it("falls back to the computed path when there is no registry row", async () => {
    const provider = fakeProvider({ hasHandleAfterDelete: false });
    const reg = openLinkSandboxRegistry({ path: ":memory:" });
    const purged: string[] = [];

    const actions = createSandboxActions({
      provider,
      registry: reg,
      dataDir: "/data",
      purge: (p) => purged.push(p),
    });

    const res = await actions.removeSandbox("ghost");

    expect(res).toEqual({ ok: true });
    expect(purged).toEqual([join("/data", "sandboxes", "ghost")]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test apps/mesh/src/link-daemon/sandbox-actions.test.ts`
Expected: FAIL — `Cannot find module "./sandbox-actions"`.

- [ ] **Step 3: Implement**

```ts
// apps/mesh/src/link-daemon/sandbox-actions.ts
/**
 * TUI → daemon action layer. The link TUI and daemon share one process, so
 * these are plain function calls. `removeSandbox` is the careful path: stop the
 * process, confirm it actually stopped (a run in flight makes the provider
 * refuse), then unmount + rm the branch's files and drop the registry row.
 */
import { join } from "node:path";
import type {
  LinkSandboxRegistry,
  SandboxInspection,
} from "../cli/link-sandbox-registry";
import type { DesktopSandboxProvider } from "./user-desktop-provider";
import { purgeSandboxFiles } from "./purge-sandbox";

export interface SandboxActionsDeps {
  provider: Pick<DesktopSandboxProvider, "deleteSandbox" | "hasHandle">;
  registry: Pick<LinkSandboxRegistry, "inspect" | "delete">;
  dataDir: string;
  /** Injectable for tests. Defaults to the real unmount-then-rm. */
  purge?: (sandboxPath: string) => void;
}

export interface SandboxActions {
  stopSandbox(handle: string): Promise<void>;
  removeSandbox(
    handle: string,
  ): Promise<{ ok: true } | { ok: false; error: string }>;
  inspectSandbox(handle: string): SandboxInspection | null;
}

export function createSandboxActions(deps: SandboxActionsDeps): SandboxActions {
  const purge = deps.purge ?? purgeSandboxFiles;

  return {
    stopSandbox(handle) {
      return deps.provider.deleteSandbox(handle);
    },
    inspectSandbox(handle) {
      return deps.registry.inspect(handle);
    },
    async removeSandbox(handle) {
      await deps.provider.deleteSandbox(handle);
      // On refusal (active dispatch) the provider keeps tracking the handle.
      if (deps.provider.hasHandle(handle)) {
        return { ok: false, error: "Can't delete — run in progress" };
      }
      try {
        const rec = deps.registry.inspect(handle);
        const sandboxPath =
          rec?.sandboxPath ?? join(deps.dataDir, "sandboxes", handle);
        purge(sandboxPath);
        deps.registry.delete(handle);
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/mesh/src/link-daemon/sandbox-actions.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Extend `LinkDaemonHandle` and wire it up in `index.ts`**

Add the import near the other link-daemon imports:

```ts
import { createSandboxActions } from "./sandbox-actions";
```

Extend the interface (`index.ts:84-87`):

```ts
export interface LinkDaemonHandle {
  stopped: Promise<number>;
  stop: () => Promise<void>;
  stopSandbox: (handle: string) => Promise<void>;
  removeSandbox: (
    handle: string,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  inspectSandbox: (handle: string) => SandboxInspection | null;
}
```

Add the `SandboxInspection` type to the existing import from `../cli/link-sandbox-registry` (that import already pulls `registryPathForDataDir`).

Just before the final `return { stopped, stop: shutdown };` (`index.ts:366`), build the actions from the already-in-scope `provider` and `registry`:

```ts
    const sandboxActions = createSandboxActions({
      provider,
      registry,
      dataDir: opts.dataDir,
    });

    return {
      stopped,
      stop: shutdown,
      stopSandbox: sandboxActions.stopSandbox,
      removeSandbox: sandboxActions.removeSandbox,
      inspectSandbox: sandboxActions.inspectSandbox,
    };
```

- [ ] **Step 6: Type-check the wiring**

Run: `bun run check`
Expected: no type errors.

- [ ] **Step 7: Commit**

```bash
bun run fmt
git add apps/mesh/src/link-daemon/sandbox-actions.ts apps/mesh/src/link-daemon/sandbox-actions.test.ts apps/mesh/src/link-daemon/index.ts
git commit -m "feat(link): daemon sandbox actions (stop/remove/inspect)"
```

---

## Task 5: `link-selection` pure math

**Files:**
- Create: `apps/mesh/src/cli/link-selection.ts`
- Test: `apps/mesh/src/cli/link-selection.test.ts`

**Interfaces:**
- Produces:
  ```ts
  function orderedHandles(sandboxes: Map<string, { handle: string }>): string[]
  function nextSelection(handles: string[], current: string | null, delta: 1 | -1): string | null
  function selectionAfterRemoval(handles: string[], removed: string, current: string | null): string | null
  ```
  `orderedHandles` mirrors the view's sort (`handle.localeCompare`) so selection order matches what's rendered.

- [ ] **Step 1: Write the failing test**

```ts
// apps/mesh/src/cli/link-selection.test.ts
import { describe, expect, it } from "bun:test";
import {
  nextSelection,
  orderedHandles,
  selectionAfterRemoval,
} from "./link-selection";

describe("orderedHandles", () => {
  it("sorts handles the way the table renders them", () => {
    const m = new Map([
      ["c", { handle: "c" }],
      ["a", { handle: "a" }],
      ["b", { handle: "b" }],
    ]);
    expect(orderedHandles(m)).toEqual(["a", "b", "c"]);
  });
});

describe("nextSelection", () => {
  const h = ["a", "b", "c"];
  it("moves down and up", () => {
    expect(nextSelection(h, "a", 1)).toBe("b");
    expect(nextSelection(h, "b", -1)).toBe("a");
  });
  it("clamps at the ends", () => {
    expect(nextSelection(h, "c", 1)).toBe("c");
    expect(nextSelection(h, "a", -1)).toBe("a");
  });
  it("seeds from an edge when nothing is selected", () => {
    expect(nextSelection(h, null, 1)).toBe("a");
    expect(nextSelection(h, null, -1)).toBe("c");
  });
  it("returns null for an empty list", () => {
    expect(nextSelection([], null, 1)).toBeNull();
  });
});

describe("selectionAfterRemoval", () => {
  const h = ["a", "b", "c"];
  it("keeps the current selection when a different row is removed", () => {
    expect(selectionAfterRemoval(h, "c", "a")).toBe("a");
  });
  it("moves to the next row when the selected row is removed", () => {
    expect(selectionAfterRemoval(h, "b", "b")).toBe("c");
  });
  it("falls back to the previous row when removing the last", () => {
    expect(selectionAfterRemoval(h, "c", "c")).toBe("b");
  });
  it("returns null when the only row is removed", () => {
    expect(selectionAfterRemoval(["a"], "a", "a")).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test apps/mesh/src/cli/link-selection.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// apps/mesh/src/cli/link-selection.ts
/** Pure selection math for the interactive link table. */

export function orderedHandles(
  sandboxes: Map<string, { handle: string }>,
): string[] {
  return [...sandboxes.values()]
    .map((r) => r.handle)
    .sort((a, b) => a.localeCompare(b));
}

export function nextSelection(
  handles: string[],
  current: string | null,
  delta: 1 | -1,
): string | null {
  if (handles.length === 0) return null;
  const idx = current === null ? -1 : handles.indexOf(current);
  if (idx === -1) return delta > 0 ? handles[0]! : handles[handles.length - 1]!;
  const clamped = Math.max(0, Math.min(handles.length - 1, idx + delta));
  return handles[clamped]!;
}

export function selectionAfterRemoval(
  handles: string[],
  removed: string,
  current: string | null,
): string | null {
  if (current !== removed) return current;
  const idx = handles.indexOf(removed);
  if (idx === -1) return current;
  return handles[idx + 1] ?? handles[idx - 1] ?? null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/mesh/src/cli/link-selection.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
bun run fmt
git add apps/mesh/src/cli/link-selection.ts apps/mesh/src/cli/link-selection.test.ts
git commit -m "feat(link): pure selection math for interactive table"
```

---

## Task 6: `link-keymap` — key → intent

**Files:**
- Create: `apps/mesh/src/cli/link-keymap.ts`
- Test: `apps/mesh/src/cli/link-keymap.test.ts`

**Interfaces:**
- Produces:
  ```ts
  type LinkIntent =
    | { type: "move"; delta: 1 | -1 }
    | { type: "stop" } | { type: "delete" } | { type: "open" } | { type: "quit" }
    | { type: "confirmYes" } | { type: "confirmNo" };
  interface KeyState { upArrow?: boolean; downArrow?: boolean; ctrl?: boolean }
  function keyToIntent(input: string, key: KeyState, pendingConfirm: boolean): LinkIntent | null
  ```

- [ ] **Step 1: Write the failing test**

```ts
// apps/mesh/src/cli/link-keymap.test.ts
import { describe, expect, it } from "bun:test";
import { keyToIntent } from "./link-keymap";

describe("keyToIntent (no pending confirm)", () => {
  it("maps arrows and j/k to move", () => {
    expect(keyToIntent("", { upArrow: true }, false)).toEqual({ type: "move", delta: -1 });
    expect(keyToIntent("", { downArrow: true }, false)).toEqual({ type: "move", delta: 1 });
    expect(keyToIntent("k", {}, false)).toEqual({ type: "move", delta: -1 });
    expect(keyToIntent("j", {}, false)).toEqual({ type: "move", delta: 1 });
  });
  it("maps action keys", () => {
    expect(keyToIntent("s", {}, false)).toEqual({ type: "stop" });
    expect(keyToIntent("d", {}, false)).toEqual({ type: "delete" });
    expect(keyToIntent("o", {}, false)).toEqual({ type: "open" });
    expect(keyToIntent("q", {}, false)).toEqual({ type: "quit" });
    expect(keyToIntent("c", { ctrl: true }, false)).toEqual({ type: "quit" });
  });
  it("returns null for unmapped keys", () => {
    expect(keyToIntent("x", {}, false)).toBeNull();
  });
});

describe("keyToIntent (pending confirm)", () => {
  it("only y confirms; everything else cancels", () => {
    expect(keyToIntent("y", {}, true)).toEqual({ type: "confirmYes" });
    expect(keyToIntent("Y", {}, true)).toEqual({ type: "confirmYes" });
    expect(keyToIntent("n", {}, true)).toEqual({ type: "confirmNo" });
    expect(keyToIntent("d", {}, true)).toEqual({ type: "confirmNo" });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test apps/mesh/src/cli/link-keymap.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// apps/mesh/src/cli/link-keymap.ts
/** Pure mapping from a keypress to an interaction intent. */

export type LinkIntent =
  | { type: "move"; delta: 1 | -1 }
  | { type: "stop" }
  | { type: "delete" }
  | { type: "open" }
  | { type: "quit" }
  | { type: "confirmYes" }
  | { type: "confirmNo" };

export interface KeyState {
  upArrow?: boolean;
  downArrow?: boolean;
  ctrl?: boolean;
}

export function keyToIntent(
  input: string,
  key: KeyState,
  pendingConfirm: boolean,
): LinkIntent | null {
  if (pendingConfirm) {
    return input === "y" || input === "Y"
      ? { type: "confirmYes" }
      : { type: "confirmNo" };
  }
  if (key.upArrow || input === "k") return { type: "move", delta: -1 };
  if (key.downArrow || input === "j") return { type: "move", delta: 1 };
  if (input === "s") return { type: "stop" };
  if (input === "d") return { type: "delete" };
  if (input === "o") return { type: "open" };
  if (input === "q" || (key.ctrl === true && input === "c")) {
    return { type: "quit" };
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/mesh/src/cli/link-keymap.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
bun run fmt
git add apps/mesh/src/cli/link-keymap.ts apps/mesh/src/cli/link-keymap.test.ts
git commit -m "feat(link): pure keymap for interactive table"
```

---

## Task 7: `link-confirm` — pending type + confirm text

**Files:**
- Create: `apps/mesh/src/cli/link-confirm.ts`
- Test: `apps/mesh/src/cli/link-confirm.test.ts`

**Interfaces:**
- Produces:
  ```ts
  interface PendingConfirm { handle: string; branch: string | null; dirtyCount: number; merged: boolean | null }
  function formatConfirm(c: PendingConfirm): string
  ```
  Consumed later by `link-store.ts` (type) and `link-app.tsx` (rendering).

- [ ] **Step 1: Write the failing test**

```ts
// apps/mesh/src/cli/link-confirm.test.ts
import { describe, expect, it } from "bun:test";
import { formatConfirm } from "./link-confirm";

describe("formatConfirm", () => {
  it("plain prompt when clean and merged", () => {
    expect(
      formatConfirm({ handle: "h", branch: "feat", dirtyCount: 0, merged: true }),
    ).toBe("Delete feat? (y/n)");
  });
  it("warns about uncommitted files (singular/plural)", () => {
    expect(
      formatConfirm({ handle: "h", branch: "feat", dirtyCount: 1, merged: true }),
    ).toBe("⚠ 1 uncommitted file — delete feat? (y/n)");
    expect(
      formatConfirm({ handle: "h", branch: "feat", dirtyCount: 3, merged: true }),
    ).toBe("⚠ 3 uncommitted files — delete feat? (y/n)");
  });
  it("warns about an unmerged branch", () => {
    expect(
      formatConfirm({ handle: "h", branch: "feat", dirtyCount: 0, merged: false }),
    ).toBe("⚠ branch not merged — delete feat? (y/n)");
  });
  it("combines warnings and falls back to handle when branch is null", () => {
    expect(
      formatConfirm({ handle: "h", branch: null, dirtyCount: 2, merged: false }),
    ).toBe("⚠ 2 uncommitted files, branch not merged — delete h? (y/n)");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test apps/mesh/src/cli/link-confirm.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// apps/mesh/src/cli/link-confirm.ts
/** Pending-delete confirmation state and its prompt text. */

export interface PendingConfirm {
  handle: string;
  branch: string | null;
  dirtyCount: number;
  merged: boolean | null;
}

export function formatConfirm(c: PendingConfirm): string {
  const label = c.branch ?? c.handle;
  const warns: string[] = [];
  if (c.dirtyCount > 0) {
    warns.push(
      `${c.dirtyCount} uncommitted file${c.dirtyCount === 1 ? "" : "s"}`,
    );
  }
  if (c.merged === false) warns.push("branch not merged");
  return warns.length > 0
    ? `⚠ ${warns.join(", ")} — delete ${label}? (y/n)`
    : `Delete ${label}? (y/n)`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/mesh/src/cli/link-confirm.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
bun run fmt
git add apps/mesh/src/cli/link-confirm.ts apps/mesh/src/cli/link-confirm.test.ts
git commit -m "feat(link): confirm state and prompt text"
```

---

## Task 8: `open-url` — cross-platform opener

**Files:**
- Create: `apps/mesh/src/cli/open-url.ts`
- Test: `apps/mesh/src/cli/open-url.test.ts`

**Interfaces:**
- Produces:
  ```ts
  function resolveOpenCommand(platform: NodeJS.Platform): string
  function openPreviewUrl(url: string, platform?: NodeJS.Platform): void
  ```

- [ ] **Step 1: Write the failing test** (pure command resolution only — no spawning)

```ts
// apps/mesh/src/cli/open-url.test.ts
import { describe, expect, it } from "bun:test";
import { resolveOpenCommand } from "./open-url";

describe("resolveOpenCommand", () => {
  it("uses the right opener per platform", () => {
    expect(resolveOpenCommand("darwin")).toBe("open");
    expect(resolveOpenCommand("win32")).toBe("start");
    expect(resolveOpenCommand("linux")).toBe("xdg-open");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test apps/mesh/src/cli/open-url.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// apps/mesh/src/cli/open-url.ts
/** Best-effort "open this URL in the user's browser" for the link TUI. */
import { spawn } from "node:child_process";

export function resolveOpenCommand(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "open";
  if (platform === "win32") return "start";
  return "xdg-open";
}

export function openPreviewUrl(
  url: string,
  platform: NodeJS.Platform = process.platform,
): void {
  const cmd = resolveOpenCommand(platform);
  try {
    spawn(cmd, [url], { stdio: "ignore", detached: true }).unref();
  } catch {
    // Opening a browser must never crash the TUI.
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/mesh/src/cli/open-url.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
bun run fmt
git add apps/mesh/src/cli/open-url.ts apps/mesh/src/cli/open-url.test.ts
git commit -m "feat(link): cross-platform preview URL opener"
```

---

## Task 9: Store — selection, confirm, error, actions

**Files:**
- Modify: `apps/mesh/src/cli/link-store.ts`
- Test: `apps/mesh/src/cli/link-store.test.ts`

**Interfaces:**
- Consumes: `orderedHandles`/`selectionAfterRemoval` (Task 5); `PendingConfirm` (Task 7); `SandboxInspection` (Task 3).
- Produces (new state on `LinkState`, all readable via `getLinkState()`):
  `selectedHandle: string | null`, `pendingConfirm: PendingConfirm | null`, `actionError: string | null`, `actions: LinkActions | null`.
  New exports:
  ```ts
  interface LinkActions {
    stopSandbox(handle: string): Promise<void>;
    removeSandbox(handle: string): Promise<{ ok: true } | { ok: false; error: string }>;
    inspectSandbox(handle: string): SandboxInspection | null;
    quit(): Promise<void>;
  }
  function setSelectedHandle(handle: string | null): void
  function setPendingConfirm(confirm: PendingConfirm | null): void
  function setActionError(message: string | null): void
  function setLinkActions(actions: LinkActions): void
  function removeSandboxRow(handle: string): void
  ```

- [ ] **Step 1: Write the failing tests** (append to existing file)

```ts
// apps/mesh/src/cli/link-store.test.ts — add these imports to the existing import block:
//   setSelectedHandle, setPendingConfirm, setActionError, removeSandboxRow, getLinkState
// (getLinkState is already imported in this file.)

describe("selection setters", () => {
  it("stores the selected handle, confirm, and error", () => {
    setSelectedHandle("h1");
    expect(getLinkState().selectedHandle).toBe("h1");

    setPendingConfirm({ handle: "h1", branch: "b", dirtyCount: 0, merged: true });
    expect(getLinkState().pendingConfirm?.handle).toBe("h1");

    setActionError("boom");
    expect(getLinkState().actionError).toBe("boom");
  });
});

describe("removeSandboxRow", () => {
  it("drops the row and follows selection to the neighbor", () => {
    setPersistedSandboxes([
      { handle: "a", status: "stopped", sandboxPath: "/a", port: null, previewUrl: null, repoCloneUrl: null, branch: null, projectName: null, error: null, createdAt: 0, updatedAt: 0, lastSeenAt: null, missingSince: null },
      { handle: "b", status: "stopped", sandboxPath: "/b", port: null, previewUrl: null, repoCloneUrl: null, branch: null, projectName: null, error: null, createdAt: 0, updatedAt: 0, lastSeenAt: null, missingSince: null },
    ]);
    setSelectedHandle("a");

    removeSandboxRow("a");

    expect([...getLinkState().sandboxes.keys()]).toEqual(["b"]);
    expect(getLinkState().selectedHandle).toBe("b");
    expect(getLinkState().pendingConfirm).toBeNull();
  });
});
```

(The `setPersistedSandboxes` record shape matches `LinkSandboxRecord`; copy the existing field set the file already uses if it differs.)

- [ ] **Step 2: Run to verify failure**

Run: `bun test apps/mesh/src/cli/link-store.test.ts`
Expected: FAIL — `setSelectedHandle`/`removeSandboxRow` not exported.

- [ ] **Step 3: Add imports and extend `LinkState`**

At the top of `link-store.ts` add:

```ts
import type { SandboxInspection } from "./link-sandbox-registry";
import type { PendingConfirm } from "./link-confirm";
import { orderedHandles, selectionAfterRemoval } from "./link-selection";
```

Add the `LinkActions` interface (exported):

```ts
export interface LinkActions {
  stopSandbox(handle: string): Promise<void>;
  removeSandbox(
    handle: string,
  ): Promise<{ ok: true } | { ok: false; error: string }>;
  inspectSandbox(handle: string): SandboxInspection | null;
  quit(): Promise<void>;
}
```

Extend the `LinkState` interface with:

```ts
  selectedHandle: string | null;
  pendingConfirm: PendingConfirm | null;
  actionError: string | null;
  actions: LinkActions | null;
```

- [ ] **Step 4: Initialize the new fields**

In `initialState()` add:

```ts
    selectedHandle: null,
    pendingConfirm: null,
    actionError: null,
    actions: null,
```

- [ ] **Step 5: Add the setters** (near the other `set*` functions)

```ts
export function setSelectedHandle(handle: string | null) {
  state = { ...state, selectedHandle: handle };
  emit();
}

export function setPendingConfirm(confirm: PendingConfirm | null) {
  state = { ...state, pendingConfirm: confirm };
  emit();
}

export function setActionError(message: string | null) {
  state = { ...state, actionError: message };
  emit();
}

export function setLinkActions(actions: LinkActions) {
  state = { ...state, actions };
  emit();
}

export function removeSandboxRow(handle: string) {
  const handles = orderedHandles(state.sandboxes);
  const selectedHandle = selectionAfterRemoval(
    handles,
    handle,
    state.selectedHandle,
  );
  const sandboxes = new Map(state.sandboxes);
  sandboxes.delete(handle);
  state = { ...state, sandboxes, selectedHandle, pendingConfirm: null };
  emit();
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test apps/mesh/src/cli/link-store.test.ts`
Expected: PASS (existing + new).

- [ ] **Step 7: Commit**

```bash
bun run fmt
git add apps/mesh/src/cli/link-store.ts apps/mesh/src/cli/link-store.test.ts
git commit -m "feat(link): store selection/confirm/error/actions state"
```

---

## Task 10: `dispatchIntent` — intent → store + actions

**Files:**
- Create: `apps/mesh/src/cli/link-dispatch.ts`
- Test: `apps/mesh/src/cli/link-dispatch.test.ts`

**Interfaces:**
- Consumes: `LinkIntent` (Task 6); store getters/setters + `LinkActions` (Task 9); `orderedHandles`/`nextSelection` (Task 5); `openPreviewUrl` (Task 8).
- Produces:
  ```ts
  interface DispatchDeps { openUrl?: (url: string) => void }
  function dispatchIntent(intent: LinkIntent, deps?: DispatchDeps): void
  ```

- [ ] **Step 1: Write the failing test**

```ts
// apps/mesh/src/cli/link-dispatch.test.ts
import { afterEach, describe, expect, it } from "bun:test";
import { dispatchIntent } from "./link-dispatch";
import {
  getLinkState,
  resetLinkStateForTests,
  setLinkActions,
  setPersistedSandboxes,
  setSelectedHandle,
  type LinkActions,
} from "./link-store";

afterEach(() => resetLinkStateForTests());

function rows() {
  setPersistedSandboxes([
    { handle: "a", status: "ready", sandboxPath: "/a", port: 1, previewUrl: "http://a", repoCloneUrl: null, branch: "ba", projectName: null, error: null, createdAt: 0, updatedAt: 0, lastSeenAt: null, missingSince: null },
    { handle: "b", status: "stopped", sandboxPath: "/b", port: null, previewUrl: null, repoCloneUrl: null, branch: "bb", projectName: null, error: null, createdAt: 0, updatedAt: 0, lastSeenAt: null, missingSince: null },
  ]);
}

function fakeActions(over: Partial<LinkActions> = {}): LinkActions {
  return {
    stopSandbox: async () => {},
    removeSandbox: async () => ({ ok: true }),
    inspectSandbox: () => null,
    quit: async () => {},
    ...over,
  };
}

describe("dispatchIntent", () => {
  it("move seeds and advances selection", () => {
    rows();
    dispatchIntent({ type: "move", delta: 1 });
    expect(getLinkState().selectedHandle).toBe("a");
    dispatchIntent({ type: "move", delta: 1 });
    expect(getLinkState().selectedHandle).toBe("b");
  });

  it("open launches the URL only for a ready row", () => {
    rows();
    setSelectedHandle("a");
    const opened: string[] = [];
    dispatchIntent({ type: "open" }, { openUrl: (u) => opened.push(u) });
    expect(opened).toEqual(["http://a"]);

    setSelectedHandle("b"); // stopped → no URL
    dispatchIntent({ type: "open" }, { openUrl: (u) => opened.push(u) });
    expect(opened).toEqual(["http://a"]);
  });

  it("delete opens a confirm using inspect data", () => {
    rows();
    setSelectedHandle("a");
    setLinkActions(
      fakeActions({
        inspectSandbox: () => ({
          handle: "a",
          branch: "ba",
          sandboxPath: "/a",
          dirtyCount: 2,
          merged: false,
        }),
      }),
    );
    dispatchIntent({ type: "delete" });
    expect(getLinkState().pendingConfirm).toEqual({
      handle: "a",
      branch: "ba",
      dirtyCount: 2,
      merged: false,
    });
  });

  it("confirmYes removes the row on success", async () => {
    rows();
    setSelectedHandle("a");
    let removed = "";
    setLinkActions(
      fakeActions({
        removeSandbox: async (h) => {
          removed = h;
          return { ok: true };
        },
      }),
    );
    dispatchIntent({ type: "delete" });
    dispatchIntent({ type: "confirmYes" });
    await Promise.resolve();
    await Promise.resolve();
    expect(removed).toBe("a");
    expect([...getLinkState().sandboxes.keys()]).toEqual(["b"]);
  });

  it("confirmYes surfaces the error on failure", async () => {
    rows();
    setSelectedHandle("a");
    setLinkActions(
      fakeActions({
        removeSandbox: async () => ({ ok: false, error: "nope" }),
      }),
    );
    dispatchIntent({ type: "delete" });
    dispatchIntent({ type: "confirmYes" });
    await Promise.resolve();
    await Promise.resolve();
    expect(getLinkState().actionError).toBe("nope");
    expect([...getLinkState().sandboxes.keys()]).toEqual(["a", "b"]);
  });

  it("confirmNo clears the pending confirm", () => {
    rows();
    setSelectedHandle("a");
    setLinkActions(fakeActions());
    dispatchIntent({ type: "delete" });
    dispatchIntent({ type: "confirmNo" });
    expect(getLinkState().pendingConfirm).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test apps/mesh/src/cli/link-dispatch.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// apps/mesh/src/cli/link-dispatch.ts
/**
 * Applies an interaction intent to the link store + daemon actions. Reads the
 * live store snapshot, derives the effective selection (mirrors the view), and
 * routes each intent to the right setter / action. Kept out of the view so the
 * whole interaction surface is unit-testable.
 */
import type { LinkIntent } from "./link-keymap";
import { openPreviewUrl } from "./open-url";
import {
  getLinkState,
  removeSandboxRow,
  setActionError,
  setPendingConfirm,
  setSelectedHandle,
} from "./link-store";
import { nextSelection, orderedHandles } from "./link-selection";

export interface DispatchDeps {
  openUrl?: (url: string) => void;
}

export function dispatchIntent(
  intent: LinkIntent,
  deps: DispatchDeps = {},
): void {
  const openUrl = deps.openUrl ?? openPreviewUrl;
  const state = getLinkState();
  const handles = orderedHandles(state.sandboxes);
  const current =
    state.selectedHandle !== null && handles.includes(state.selectedHandle)
      ? state.selectedHandle
      : (handles[0] ?? null);
  const actions = state.actions;

  switch (intent.type) {
    case "move":
      setSelectedHandle(nextSelection(handles, current, intent.delta));
      return;
    case "open": {
      if (current === null) return;
      const row = state.sandboxes.get(current);
      if (row?.status === "ready" && row.previewUrl) openUrl(row.previewUrl);
      return;
    }
    case "stop":
      if (current !== null && actions) void actions.stopSandbox(current);
      return;
    case "delete": {
      if (current === null || !actions) return;
      const info = actions.inspectSandbox(current);
      const row = state.sandboxes.get(current);
      setActionError(null);
      setPendingConfirm({
        handle: current,
        branch: info?.branch ?? row?.branch ?? null,
        dirtyCount: info?.dirtyCount ?? 0,
        merged: info?.merged ?? null,
      });
      return;
    }
    case "confirmYes": {
      const confirm = state.pendingConfirm;
      setPendingConfirm(null);
      if (confirm === null || !actions) return;
      void actions.removeSandbox(confirm.handle).then((res) => {
        if (res.ok) removeSandboxRow(confirm.handle);
        else setActionError(res.error);
      });
      return;
    }
    case "confirmNo":
      setPendingConfirm(null);
      return;
    case "quit":
      if (actions) void actions.quit();
      return;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/mesh/src/cli/link-dispatch.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
bun run fmt
git add apps/mesh/src/cli/link-dispatch.ts apps/mesh/src/cli/link-dispatch.test.ts
git commit -m "feat(link): dispatchIntent wiring for interactive table"
```

---

## Task 11: Wire the view (`link-app.tsx`) + `link.ts` actions

**Files:**
- Modify: `apps/mesh/src/cli/link-app.tsx`
- Modify: `apps/mesh/src/cli/commands/link.ts` (after `startLinkDaemon`, `:227-236`)

**Interfaces:**
- Consumes everything above: store state + `keyToIntent` + `dispatchIntent` + `formatConfirm` + `setLinkActions`.
- This task is integration glue; logic is already unit-tested. Verify via `bun run check`, `bun run lint`, and the manual checklist in Step 5.

- [ ] **Step 1: Add `useInput`, selection highlight, confirm line, footer, and legend to `link-app.tsx`**

Update the imports at the top:

```tsx
import { Box, Text, useInput } from "ink";
import { useSyncExternalStore } from "react";
import pkg from "../../package.json" with { type: "json" };
import { Banner } from "./banner";
import { formatConfirm } from "./link-confirm";
import { dispatchIntent } from "./link-dispatch";
import { keyToIntent } from "./link-keymap";
import { orderedHandles } from "./link-selection";
import {
  getLinkState,
  type SandboxRow,
  subscribeLinkState,
} from "./link-store";
```

Inside `LinkApp`, after `const state = useSyncExternalStore(...)` and the existing `rows` sort, compute the effective selection and install input handling:

```tsx
  const handles = orderedHandles(state.sandboxes);
  const selected =
    state.selectedHandle !== null && handles.includes(state.selectedHandle)
      ? state.selectedHandle
      : (handles[0] ?? null);

  useInput((input, key) => {
    const intent = keyToIntent(input, key, state.pendingConfirm !== null);
    if (intent !== null) dispatchIntent(intent);
  });
```

In the row `.map((row) => { ... })`, mark the selected row. Change the row's outer `<Box key={row.handle}>` to prefix a caret and bold the selected line:

```tsx
          {rows.map((row) => {
            const s = statusCell(row);
            const isSelected = row.handle === selected;
            return (
              <Box key={row.handle}>
                <Box width={2} flexShrink={0}>
                  <Text color="cyan">{isSelected ? "›" : " "}</Text>
                </Box>
                <Box width={COLS.project} flexShrink={0} marginRight={1}>
                  <Text bold={isSelected} wrap="truncate-end">
                    {row.projectName ?? row.handle}
                  </Text>
                </Box>
                <Box width={COLS.branch} flexShrink={0} marginRight={1}>
                  <Text bold={isSelected} wrap="truncate-end">
                    {row.branch ?? "—"}
                  </Text>
                </Box>
                <Box width={COLS.status} flexShrink={0} marginRight={1}>
                  <Text color={s.color} bold={isSelected} wrap="truncate-end">
                    {s.text}
                  </Text>
                </Box>
                <Box flexGrow={1}>
                  <Text dimColor wrap="truncate-end">
                    {row.previewUrl ?? "—"}
                  </Text>
                </Box>
              </Box>
            );
          })}
```

Add a matching 2-wide spacer to the header row (so columns line up) — prepend to the header `<Box>` (the one containing `PROJECT`/`BRANCH`/…):

```tsx
          <Box>
            <Box width={2} flexShrink={0} />
            <Box width={COLS.project} flexShrink={0} marginRight={1}>
              <Text dimColor wrap="truncate-end">
                PROJECT
              </Text>
            </Box>
            {/* …unchanged BRANCH / STATUS / PREVIEW URL … */}
          </Box>
```

Finally, before the closing `</Box>` of the component (after the existing `daemonError` / `logPath` blocks), add the confirm line, action error, and the persistent legend:

```tsx
      {state.pendingConfirm ? (
        <Box marginTop={1}>
          <Text color="yellow">{formatConfirm(state.pendingConfirm)}</Text>
        </Box>
      ) : null}
      {state.actionError ? (
        <Box marginTop={1}>
          <Text color="red">✗ {state.actionError}</Text>
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text dimColor>↑↓ move · s stop · d delete · o open · q quit</Text>
      </Box>
```

- [ ] **Step 2: Supply the actions to the store after the daemon starts (`link.ts`)**

In `apps/mesh/src/cli/commands/link.ts`, immediately after `const handle = await startLinkDaemon({...});` and before `return await handle.stopped;` (`:227-236`), add:

```ts
    if (opts.tui) {
      const { setLinkActions } = await import("../link-store");
      setLinkActions({
        stopSandbox: handle.stopSandbox,
        removeSandbox: handle.removeSandbox,
        inspectSandbox: handle.inspectSandbox,
        quit: handle.stop,
      });
    }
```

- [ ] **Step 3: Type-check and lint**

Run: `bun run check`
Expected: no type errors.

Run: `bun run lint`
Expected: no new violations (in particular, no `useEffect`/memoization — this task uses neither).

- [ ] **Step 4: Run the full affected unit suites once**

Run: `bun test apps/mesh/src/cli/ apps/mesh/src/link-daemon/`
Expected: PASS.

- [ ] **Step 5: Manual verification** (interactive TTY — cannot be unit-tested)

Start a link session with at least one sandbox and confirm:
1. `bunx decocms link` (or `bun run --cwd=apps/mesh dev` flow) renders the table with a `›` caret on the first row and the legend at the bottom.
2. `↑`/`↓` and `j`/`k` move the caret and bold the selected row; it clamps at both ends.
3. `o` on a `● Live` row opens the preview URL in the browser; `o` on a stopped row does nothing.
4. `s` on a live row turns it `■ Stopped` (files remain on disk).
5. `d` on a clean, merged branch shows `Delete <branch>? (y/n)`; on a dirty/unmerged one shows the `⚠ …` variant. `n` cancels; `y` removes the row and the on-disk directory. Confirm with `ls ~/…/sandboxes` that the folder is gone and the command did **not** hang (the org-fs mount was detached first).
6. `d` on a sandbox with a run in flight shows `✗ Can't delete — run in progress` and keeps the row.
7. `q` exits cleanly (daemon shuts down).

- [ ] **Step 6: Commit**

```bash
bun run fmt
git add apps/mesh/src/cli/link-app.tsx apps/mesh/src/cli/commands/link.ts
git commit -m "feat(link): interactive table with stop/delete/open keys"
```

---

## Self-Review Notes

- **Spec coverage:** §1 interaction model → Tasks 5,6,11; §2 delete flow (confirm/stop/unmount/rm/drop) → Tasks 2,3,4,7,10,11; §3 reverse channel → Tasks 4,9,11; §4 store/input → Tasks 9,10,11; §5 testing → unit tests in Tasks 2–10, manual/integration in Task 11. Deferred `r`/restart is out of scope per spec. Remote mutation excluded.
- **Type consistency:** `removeSandbox` returns `{ ok: true } | { ok: false; error: string }` in Tasks 4, 9, 10, 11. `SandboxInspection` (Task 3) is consumed by Tasks 4, 9. `PendingConfirm` (Task 7) is consumed by Tasks 9, 10, 11. `LinkIntent` (Task 6) by Tasks 10, 11. `LinkActions` (Task 9) by Tasks 10, 11.
- **Unmount-before-rm** (the user's key requirement) is enforced in Task 2 (`purgeSandboxFiles`) and exercised by Task 4's orchestration; the B1 strategy (detach direct children of `<sandboxPath>/org/`) is implemented literally.
