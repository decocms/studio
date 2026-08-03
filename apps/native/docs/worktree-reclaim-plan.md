# Worktree reclaim on last-thread archive — implementation plan

Gives the desktop app a way to stop a sandbox's processes and delete its git
worktree. Today it has neither: nothing in `apps/native` ever removes a
worktree, so every branch a user has ever opened stays on disk forever.

**Status:** implemented. This doc was written as a plan and has been updated to
match what shipped; where the two diverged during review, the shipped behavior
wins and the reasoning is kept so the tradeoff stays legible.

## Why

`SANDBOX_DELETE` (`apps/api/src/tools/sandbox/delete.ts`) has exactly one
production caller — `stop()` in
`apps/web/src/components/sandbox/hooks/sandbox-lifecycle-context.tsx:643`,
reached from the preview drawer's Stop and Restart buttons.

On the hosted provider that call reclaims everything: `deleteSandboxClaim`
(`packages/sandbox/server/provider/agent-sandbox/runner.ts:539`) destroys the
claim, and the operator garbage-collects the pod and its disk.

On the desktop it reclaims nothing durable. The native intercept
(`apps/native/crates/local-api/src/routes/intercept/sandbox_lifecycle.rs:507`)
calls `SandboxManager::stop_registered`, which kills the `setup`/`dev`/`start`
tasks and marks the registry row `stopped`. The worktree stays on disk. There
is no removal path at all:

- `SandboxRegistry` has no removal method. Its API is `open / upsert_config /
  record / records_for_agent / handles / contains / handle_for_agent /
  set_active / active_handle / mark_state / mark_observed`
  (`sandbox/registry.rs:93-445`).
- The only `remove_dir_all` on a worktree is the invalid-repo recovery path
  (`sandbox/manager.rs:798`), which clears a half-cloned workdir in order to
  re-clone it — not a user-facing reclaim.

So the disk cost of a branch is permanent, and the user has no affordance to
say otherwise.

## Decisions

**The trigger is archiving the last chat on a branch.** A worktree's identity
is `(repo, branch)` — `manager.rs:345` calls one worktree per `(repo, branch)`
"the deliberate consequence" — and `threads.branch`
(`apps/api/src/storage/types.ts:962`) is N:1 onto branch. So "no non-archived
threads left on this branch" is exactly "this worktree has no remaining owner".
No new concept is introduced; the trigger rides an action users already take.

**The confirm is a React dialog, and it gates the archive itself.** Confirm →
archive proceeds, then the worktree is reclaimed. Cancel → nothing happens at
all; the thread is not archived. This keeps one decision in one place instead
of splitting "archive?" from "reclaim?" across two prompts.

Rejected: a Tauri native dialog driven from Rust. `local-api` is
Tauri-agnostic — `AppState` (`state.rs:75-112`) has no `AppHandle` and
`tauri-plugin-dialog` is not a dependency — so it would need an
`UpdateHooks`-style injected capability. Worse, `thread_tools::update` holds
the agent-session start lock across its await (`thread_tools.rs:737-742`), so
blocking there on a human decision stalls concurrent starts on that fence.

**Desktop-only, via the existing knob.** `isDesktopAppEnvironment()`
(`apps/web/src/hooks/use-is-desktop-app.ts:34`) reads the build-time
`VITE_TAURI_APP` constant, so Vite dead-code-eliminates this whole path out of
the web bundle. That file is explicit that every desktop-vs-web gate goes
through it and no second detection mechanism may be added.

**`apps/api` gets interface changes only.** `removeWorktree` is inert on the
hosted path — claim teardown already destroys the pod's filesystem. Nothing else
in `apps/api` changes: a `where.branch` list filter was added and then reverted
once the sibling check moved in-browser (see P1), because an unused filter is
dead code.

**`removeWorktree` defaults to `false`.** `restart()` is `await stop(); start()`
(`sandbox-lifecycle-context.tsx:665`). A flipped default would re-clone the repo
on every restart and destroy uncommitted work.

**`remove_registered` always succeeds — it never refuses on a dirty or unpushed
worktree.** A primitive that sometimes declines would be a worse contract than
one that does what it is asked — it would split the policy
across two layers, make the outcome depend on state the caller cannot see, and
break the idempotent `{ success }` shape the intercept already promises
(`sandbox_lifecycle.rs:504-506`). Policy lives in the dialog; the primitive
executes.

## Layout

```
apps/api/src/tools/sandbox/delete.ts        + removeWorktree input  (schema only)
packages/shared/src/tools/tool-io.ts        regenerated

apps/native/crates/local-api/src/
  sandbox/registry.rs                       + remove(handle)
  sandbox/manager.rs                        + remove_registered(handle)
  routes/intercept/sandbox_lifecycle.rs     honor removeWorktree
  routes/intercept/thread_tools.rs          list() answers unpaginated
  routes/threads/db.rs                      drop LIMIT/OFFSET from the list

apps/web/src/
  hooks/use-is-desktop-app.ts               (unchanged — the gate)
  components/sidebar/task-groups/
    task-groups-list.tsx                    handleArchive → confirm flow
    archive-worktree-dialog.tsx             new
  i18n/en/…, i18n/pt-br/…                   new dialog strings
```

`thread_tools.rs`'s archive/delete handlers are **not** touched. The trigger
lives in React, so the Rust thread store only needs to answer a list query.

## Phases

### P0 — Rust reclaim primitive

The only phase that removes anything from disk. Independently testable via the
existing HTTP intercept before any UI exists.

**`sandbox/registry.rs`** — add `remove(handle)`. It must clear the active
pointer when the removed handle is the active one;
`reconcile_after_process_start` (`:477`) already does exactly that when a
workdir goes missing and is the precedent to follow.

**`sandbox/manager.rs`** — add `remove_registered(handle)` beside
`stop_registered` (`:609`), under the same per-handle lock:

1. `stop_registered` — terminate `setup`/`dev`/`start`, drop the in-memory
   sandbox, publish the generation change.
2. `remove_dir_all(worktree_root(&self.app_root, handle))` — helper at
   `sandbox/mod.rs:41`.
3. `repo_store::prune_worktrees(&self.app_root, &clone_url)`.
4. `registry.remove(handle)`.

Step 3 is **mandatory, not cleanup**. Git keeps listing a worktree after its
directory is gone and refuses to re-add one at a path it already knows — the
regression `repo_store.rs:115-123` documents. Skipping it means the branch can
never be re-created.

**`routes/intercept/sandbox_lifecycle.rs:507`** — read `removeWorktree` from
the body it already parses (this handler needs no upstream read) and dispatch
to `remove_registered` vs `stop_registered`. Absent/false keeps today's
behavior exactly.

Tests: `remove_registered` on a live handle removes the directory, drops the
registry row, clears `active_handle` when it was active, and leaves the
canonical repo re-worktree-able (assert a subsequent `ensure` on the same
branch succeeds — that is the `prune_worktrees` regression). Unknown handle is
a no-op success, matching the tool's idempotent contract.

### P1 — Tool contracts

**`apps/api/src/tools/sandbox/delete.ts`** — add to the input schema:

```ts
removeWorktree: z.boolean().optional().default(false)
  .describe("Also reclaim the sandbox's workspace (local worktree + disk). Ignored by providers whose teardown already destroys the filesystem."),
```

Handler untouched.

**`apps/native/.../thread_tools.rs`** `list()` — answer the thread list in FULL,
ignoring a caller's `limit`/`offset` (still parsed, so a malformed value is
still a 400) and always reporting `hasMore: false`. `routes/threads/db.rs` drops
`LIMIT/OFFSET` from the query to match.

This is a deliberate divergence from the tool contract, and it is what makes P2
cheap: the store is one account's local SQLite, so "every open thread" is a few
hundred rows, and answering in full lets the desktop UI treat its in-memory list
as COMPLETE rather than as a paginated sample. Threads only — `messages_list`
stays paginated, since a single chat's messages are unbounded.

An earlier revision instead added a `where.branch` filter here and in
`apps/api`, so the dialog could ask the server for a branch-scoped count. The
unpaginated list makes that filter unreachable, so it was reverted rather than
left as dead code.

Then `bun run --cwd=apps/api generate:tool-contracts`.

### P2 — React confirm flow

`handleArchive` (`task-groups-list.tsx:231-257`) is the single choke point —
every archive affordance routes through it (`task-group.tsx:56`,
`my-threads-section.tsx:87`).

Today's body — `hide(task.id)` → `forgetThreadLayout` → `findArchiveFallback` →
navigate — moves wholesale behind the confirm, because cancel must perform
**none** of it. Extract it as `archiveNow(task)` and keep it byte-identical.

```
handleArchive(task):
  owner guard                                    (unchanged, :235-237)
  if !isDesktopAppEnvironment() or !task.branch  → archiveNow(task)
  if siblings on branch > 0                      → archiveNow(task)
  else open dialog:
      cancel  → return                           (thread stays open)
      confirm → archiveNow(task)
                SANDBOX_DELETE { virtualMcpId, branch,
                                 sandboxProviderKind: "user-desktop",
                                 removeWorktree: true }
```

**The sibling check is a local predicate, with no query behind it.**
`hasOpenSiblingOnBranch(allThreads, target)` reads the loaded feed directly.
That is sound ONLY because of P1: the desktop list arrives complete, so an
empty result genuinely means "nobody else on this branch" rather than "nobody
else on the page we happen to hold". Off the desktop the feed IS a paginated
sample — which is why the whole flow is gated on `isDesktopAppEnvironment()`
before this predicate is ever consulted. It also keeps `handleArchive`
synchronous.

**Order: archive must *land* before the delete is issued** — not merely be
dispatched first. `hide()` is optimistic: `optimisticHide`
(`thread-manager-store.ts:281-308`) restores the row and rethrows when the
server refuses. Firing the reclaim without awaiting it means a rejected archive
leaves the chat visible in the sidebar with its worktree already deleted —
exactly the inversion this rule exists to prevent. Await the archive; on
rejection, abort the sequence and delete nothing.

A failed *delete*, by contrast, is fine: an archived thread plus a live
worktree is a recoverable leak, and the toast says so.

**`sandboxProviderKind` is hardcoded `"user-desktop"`.** `stop()` reads it off
`vmEntry` (`sandbox-lifecycle-context.tsx:645`), but the sidebar has no
`vmEntry` for an arbitrary thread; this path is desktop-gated, where that is
the only possible value.

**The dialog is static.** It names the branch, states the two consequences
(processes stopped, local files deleted), and asks. It does NOT inspect the
branch for uncommitted or unpushed work, so it makes no claim either way about
what is saved — see Risks. Earlier revisions itemized the loss (file and commit
counts, then a single conditional warning line); both were dropped in favour of
trusting the user to know their own branch state. Strings go through `t()` per
the i18n rules in `CLAUDE.md`; the user-facing noun is **chat**, the code
identifier stays **thread**.

## Non-goals

- **A worktree management surface.** Deliberately not built; reclaim is meant
  to be organic, riding an action users already take.
- **Reclaim on thread *delete*.** `apps/api/src/tools/thread/delete.ts` (64
  lines) has zero sandbox awareness and reaches the same orphaned state. Same
  shape of fix, deferred to keep this change one flow. Tracked as follow-up.
- **Hosted behavior.** `removeWorktree` is inert on `agent-sandbox`.
- **Idle reaping.** The hosted side has a 15-minute idle TTL
  (`runner.ts:150`); the desktop has no equivalent and is not getting one here.

## Risks

**Uncommitted or unpushed work is destroyed with no warning anywhere in the
flow.** The highest-severity risk, and the one the design deliberately accepts:
`remove_registered` never refuses on a dirty worktree, and the dialog does not
inspect the branch, so nothing between Continue and `rm -rf` knows whether work
would be lost. `compute_status` (`routes/git.rs:106`) already returns
`workingTreeDirty` and `unpushed`, so surfacing it is cheap if this proves too
sharp in practice — the deliberate choice was that a warning shown on every
archive teaches people to click through it, including the one time it was true.
Revisit if anyone actually loses work.

**Archive is reversible; this is not.** `thread/update.ts:120-126` just flips
`hidden` and fires `chat_archived` / `chat_unarchived`. Unarchiving after a
reclaim yields a chat whose branch is gone from disk — recoverable from the
remote only if the branch was pushed, which nothing verifies.

**The sibling check is racy.** Between the predicate and the archive, another
client can create a thread on the same branch. The window is small and the loss
is a worktree that re-creates on next start; not worth a lock.

**The local feed is scoped to the current user.** `hasOpenSiblingOnBranch` reads
a list the store fetched with `created_by: "me"`, so a teammate's chat on the
same branch is invisible to it. Moot on the desktop — the intercept answers from
a single-account local store, so no teammate's thread is reachable there by any
path — but it is a real constraint if this flow is ever un-gated from
`isDesktopAppEnvironment()`.

## Verification

Automated (all green as of this commit):

```bash
cargo test --manifest-path apps/native/Cargo.toml -p local-api   # P0 + P1
bun run check && bun run lint && bunx knip
bun test apps/web/src/components/sidebar/
```

`apps/api`'s `*.integration.test.ts` need a live Postgres and fail with
connection-refused without one; that is unrelated to this change.

**Still unverified: the end-to-end run in the app.** Everything above exercises
the pieces in isolation. What no test covers is the three phases wired together
in the packaged app:

1. Open two chats on one branch; archive the first — no dialog, worktree intact.
2. Archive the second — the dialog appears and names the branch.
3. Cancel — the chat stays OPEN (not archived) and the worktree is still there.
   Cancel performing a partial archive is the failure mode to watch for.
4. Archive again, Continue — the chat archives, the dev server stops, and
   `<app_root>/worktrees/<handle>` is gone.
5. Start the same branch again — it must re-clone cleanly. This is the
   `prune_worktrees` assertion end to end: git keeps listing a removed worktree
   and refuses to re-add at that path, so a missing prune makes the branch
   permanently un-recreatable.

Note `bun run dev:native` needs `src-tauri/binaries/rclone-*`, which only
`beforeBuildCommand` fetches — a fresh clone or worktree must run
`apps/native/scripts/fetch-rclone.sh` first or the build fails on a missing
resource path.
