# Interactive `deco link` TUI — Design

Date: 2026-07-01
Status: Approved (brainstorm) — ready for implementation planning

## Problem

`bunx decocms link` (`deco link`) renders a live, **read-only** Ink table of the
sandboxes running on this machine (PROJECT / BRANCH / STATUS / PREVIEW URL). The
user can see state but cannot act on it. We want to make the table interactive:
select a row with the arrow keys and act on it — stop a sandbox, delete a branch
locally, open its preview URL.

## Current implementation (baseline)

- Entry: `apps/mesh/src/cli/commands/link.ts` renders the Ink app when attached to
  a TTY (`--no-tui` streams plain logs instead).
- View: `apps/mesh/src/cli/link-app.tsx` (`LinkApp`) — subscribes to an external
  store via `useSyncExternalStore`. **No input handling, no selection today.**
- Store: `apps/mesh/src/cli/link-store.ts` — one-directional. The daemon pushes
  cluster/ingress/sandbox lifecycle updates through a `monitor` object
  (`onEvent`, `onIngress`, `onCluster`, `onMachine`); the view only reads.
- Rows: `SandboxRow` sourced from a SQLite registry
  (`apps/mesh/src/cli/link-sandbox-registry.ts`) plus live `SandboxEvent`s.
- Daemon: `apps/mesh/src/link-daemon/index.ts` `startLinkDaemon()` owns a
  `provider` (`DesktopSandboxProvider`, `user-desktop-provider.ts`) and the
  `registry`. Returns a `LinkDaemonHandle` exposing only `{ stopped, stop }`.

### Relevant existing operations

- `provider.deleteSandbox(handle)` (`user-desktop-provider.ts:635`) — despite the
  name, this is **stop**: SIGTERM the sandbox process, mark the row `stopped`,
  **keep files on disk**. Refuses if `activeDispatchCount > 0`
  (`user-desktop-provider.ts:650`).
- `registry.prune({ missing, merged })` — batch/heuristic cleanup that does
  `rmSync(sandboxPath)` **only** when the branch is merged into default and the
  worktree is clean (`link-sandbox-registry.ts:513`). Not targeted.
- `detachMount(mountPath, isMac)` (`packages/sandbox/daemon/org-fs/mounter.ts:117`)
  — best-effort, force, **never-hangs** unmount (`umount -f` on macOS /
  `fusermount -u` → `umount` on Linux, 5s timeout).

### Filesystem layout (why unmount matters)

- `sandboxPath(handle)` = `${dataDir}/sandboxes/<handle>`
  (`index.ts:104`, `user-desktop-provider.ts:267`).
- The sandbox daemon's `APP_ROOT` **is** that same `sandboxPath` (`index.ts:132`).
- Org-FS volumes mount at `<appRoot>/org/<volume-path>` =
  **`<sandboxPath>/org/...`** (`mount-manager.ts:128`), one mountpoint per volume.

Because the mounts are **nested inside the directory we delete**, a naive
`rmSync(sandboxPath, { recursive })` descends into a live NFS/FUSE mount and
hangs. The daemon unmounts on its own clean SIGTERM shutdown, but an unclean exit
(OOM, crash, sleep/wake) leaves a ghost mount — that is the hang case the delete
flow must defend against.

## Goals

1. Arrow-key (and `j`/`k`) row selection in the sandbox table.
2. Per-row actions: `s` stop, `d` delete-branch-locally, `o` open preview URL.
3. Deletes never hang on a live mount.
4. Destructive deletes are confirmed, and the confirmation surfaces risk
   (dirty worktree / unmerged branch).

## Non-goals (deferred)

- **`r` / restart a stopped sandbox.** Restart requires reconstructing the full
  `ensureSandbox` input (repo ref, workload, org-fs config), which the daemon
  normally receives from the cluster, not from local state. Fast-follow.
- Any remote mutation (deleting remote branches, GitHub repos, or the studio-side
  project). `d` is **local filesystem only**.

## Design

### 1. Interaction model

- Table gains a **selected row** (visually highlighted).
- Navigation: `↑`/`↓` and `j`/`k`. Selection clamps to `[0, rows.length-1]`.
  When the selected row is removed (deleted), selection moves to the nearest
  remaining row.
- Keymap (v1):
  | Key | Action |
  |-----|--------|
  | `↑`/`↓`, `j`/`k` | Move selection |
  | `s` | Stop selected sandbox (keep files) → `■ Stopped` |
  | `d` | Delete selected branch locally (stop + unmount + `rm`) → row removed |
  | `o` | Open preview URL in browser (only when `● Live` with a URL) |
  | `q` / `Ctrl-C` | Quit link |
- A persistent one-line **key legend** at the bottom, e.g.
  `↑↓ move · s stop · d delete · o open · q quit`. No separate help screen.
- `o` shells out to the platform opener (`open` macOS / `xdg-open` Linux /
  `start` Windows), best-effort; failures surface in the footer, never throw.

### 2. Delete flow (`d`)

Executed by the daemon (`removeSandbox`, see §3). Steps:

1. **Confirm (inline).** Render on/under the selected row:
   `Delete <branch>? (y/n)`. If the worktree is **dirty** or the branch is
   **not merged into default**, show it:
   `⚠ <n> uncommitted files — delete <branch>? (y/n)`.
   Only `y` proceeds; any other key cancels. (Chosen: Q2 option B.)
2. **Stop + wait.** `provider.deleteSandbox(handle)` (SIGTERM) and wait for the
   process to actually exit. If it refuses (active dispatch in flight), abort and
   surface `Can't delete — run in progress` in the footer. No files touched.
3. **Unmount (B1).** Enumerate the **direct children of `<sandboxPath>/org/`**
   and `detachMount` each (bounded, force, never-hangs). No system mount-table
   parsing. This covers every configured volume without needing the stored
   config, and detaches the child mountpoints (not just the `org/` parent).
4. **Remove files.** `rmSync(sandboxPath, { recursive, force })`.
5. **Drop the row.** `registry.delete(handle)` (new targeted single-row delete)
   and emit an event so the store removes the row.

`s` is step 2 only (`provider.deleteSandbox`), leaving the stopped row in place.

### 3. Reverse channel (TUI → daemon)

Today: daemon → `monitor` → store → view (one-way). Actions need the reverse.

- **Extend `LinkDaemonHandle`** (`link-daemon/index.ts:84`) with methods that
  close over the in-scope `provider` + `registry`:
  - `stopSandbox(handle): Promise<void>` — wraps `provider.deleteSandbox`.
  - `removeSandbox(handle): Promise<{ ok: true } | { error: string }>` —
    orchestrates the §2 step 2→5 delete flow.
- `link.ts` passes these action methods into `LinkApp` (props or via the store),
  keeping the view declarative.
- **Extract `detachMount`** from `packages/sandbox/daemon/org-fs/mounter.ts` into
  a small shared module importable by both the sandbox daemon and the link daemon
  (`apps/mesh`), with **no behavior change** — the sandbox daemon keeps using it.
- **`registry.delete(handle)`** — new targeted single-row delete, distinct from
  the heuristic batch `prune`.

### 4. Store & input changes

- `link-store.ts` gains:
  - `selectedHandle` (or index) with pure move/clamp/removal-follow helpers.
  - `pendingConfirm: { handle, dirtyCount, merged } | null`.
  - `actionError: string | null` (transient footer message).
  - New setters, keeping the existing pure-reducer style.
- `link-app.tsx` gains an Ink `useInput` handler (**no `useEffect`** — compliant
  with `plugins/ban-use-effect.ts`) mapping keys → store setters / daemon action
  calls, plus row highlight and confirm-line rendering.

### 5. Testing

Per `TESTING.md` (two tiers):

- **Unit (`bun test`, pure logic only):**
  - Selection reducer: move, clamp at bounds, follow-on-removal.
  - Keymap → intent mapping.
  - `registry.delete(handle)` against a temp dir (no real mount).
- **E2E / integration (real process boundary):**
  - The mount-detach + `rmSync` orchestration and the daemon action methods.
  - `detachMount` stays **injectable** into the orchestration so it can be tested
    without real NFS.

## Key decisions (from brainstorm)

- `d` = stop + remove branch from **local filesystem only**; no remote mutation. (Q1)
- Confirm with risk-surfacing prompt for dirty/unmerged. (Q2 → B)
- Ship `s`/`d`/`o` + nav + persistent legend; defer `r`/restart. (Q3)
- Delete must unmount before `rmSync`; ghost mounts are the hang risk. (Q4)
- Unmount strategy = detach direct children of `<sandboxPath>/org/` (B1), no
  mount-table parsing. (Q5 → B → B1)
- Reverse channel = extend `LinkDaemonHandle` with `stopSandbox` / `removeSandbox`.
- `detachMount` extracted to a shared module (no behavior change).
