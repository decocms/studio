# Collaboration sandboxes

Many people editing one sandbox — one working tree, one dev server, one preview
URL — with each other's changes visible as they happen.

This is the **second** attempt. The first one shipped and was reverted. Read
[Starting point](#starting-point) before designing anything.

---

## Starting point

**Today: hosted sandboxes are per-user.** `SandboxId` is `{ userId, projectRef }`
and `sandboxIdKey` is `userId:projectRef`, so the claim handle contains the user
and a teammate's sandbox is unreachable except through its public `previewUrl`.

**The first attempt was reverted.** #5112 (share by branch), #5116 (always share,
flag deleted) and #5132 (shared `staging` default) shipped to production; #5240
reverted all three on 2026-07-27, and migration `147-drop-agent-sandbox-tables`
dropped `agent_sandbox_sessions` and `agent_sandbox_runner_state` — the latter
because its `state` blob held plaintext clone-URL tokens with no org FK and
nothing to GC it.

So this is **greenfield**, not fix-forward. The 16-hole audit of the first
attempt is therefore not an incident list — it is the **requirements list**. Every
hole below is something the design has to answer before code, because each one
was found in shipped code the first time.

**What survived the revert and is still load-bearing:**

| Thing | Where | State |
| --- | --- | --- |
| `withClaimGitLock` | `apps/api/src/api/routes/sandbox-proxy.ts:250` | Per-**process** `Map`, git routes only. Serializes nothing across API pods. |
| Worktree lock | `packages/sandbox/daemon-go/internal/worktree` | **Landed** (see [Phase 0](#phase-0--landed)). The Go daemon is the only daemon, so this covers production. |
| Remote-branch-name validation | `daemon-go/internal/gitx/*` | Kept; `origin/HEAD` lookup restored (so hole 12 is closed). |
| Org-fs least-privilege narrowing | `file-storage/mount/provisioning.ts` | Kept. Revocation still missing (hole 07). |

---

## What "collaboration" is, and what it is not

Scope it before designing it, because the two readings need completely different
machinery.

**In scope — shared workspace.** Several people (and their agent runs) point at
one pod. Each sees the others' *saved* files, one dev server, one preview. Writes
are serialized; who wrote what is attributable; publish commits a known set of
paths under a known identity.

**Out of scope — collaborative text editing.** Character-level concurrent editing
of one open buffer is CRDT/OT territory, needs a persistent document server, and
is not what a sandbox is. The file watcher plus SSE already delivers
"see each other's saves within 300ms".

> The lazy answer that holds: **file-level soft ownership**, not character-level
> merge. Surface "Ana is editing `Hero.tsx`", let the second writer through with a
> warning, and never silently merge. Revisit only if users actually collide on
> single files, which per-file ownership will tell you.

**Accepted, documented properties** (not bugs — say them out loud in the UI):

- A shared sandbox is an **org-wide read surface**. An agent run in one thread can
  read every file every other writer is touching, including `.env` files written
  by tools. There is no per-editor filesystem scope. *(hole 08)*
- The **dev server is singular**. A restart, a port change, a crash is global. It
  cannot be per-user without a second server.
- `bash` and `exec` **cannot be serialized**. They are long-running; holding the
  tree lock around them would stall every other writer for the length of a
  command. A bash write can therefore still interleave with a publish.

---

## Requirements, derived from the audit

Each row is a hole from the first attempt, restated as a thing the new design
must answer. `P0` = caused data loss in production.

| # | Requirement | Sev |
| --- | --- | --- |
| R1 | A shared session's lifetime is **not** a thread's lifetime. Deleting a chat must not destroy a pod other people are writing in. | P0 |
| R2 | Publish stages an **explicit path set**, under the **acting** user's identity. Never "whatever is dirty", never "whoever started the sandbox". | P0 |
| R3 | Teardown (stop/restart/delete) is refused while another session is attached or the tree is dirty, and the refusal is **visible to whoever pressed the button**. | P0 |
| R4 | Every mutating path is serialized per shared tree — not per thread, and not per API process. | P0 |
| R5 | State transitions complete in a **worker**, never inline in a viewer's `GET`. A pod must not leak because nobody reconnected. | P0 |
| R6 | No user's GitHub token sits in a tree that other identities can `cat`. Commits are authored by the **actor**, not the starter. | P1 |
| R7 | Credentials (org-fs mount key, git access) are **session-scoped and revoked** on teardown and on membership change. | P1 |
| R8 | A ready session is **not re-provisioned** on every turn. | P1 |
| R9 | User-scoped secrets either resolve per acting user or produce a clear, migratable error. | P1 |
| R10 | The sharing unit is **explicit**, and there is a **default-off kill switch** from the first commit. | P1 |
| R11 | Provisioning is reaped on a **heartbeat**, not a wall-clock guess. One caller's failed request never reaps the shared session. | P2 |
| R12 | Orphan sessions and pods have a **reconciliation sweep**. | P2 |

---

## Design

### 1. Sharing is explicit, never derived

The first attempt's root cause was not a missing lock — it was that
`(org, virtualMcp, branch)` plus a `staging` **default** silently collapsed every
chat in an org onto one pod. Nobody opted in. *(R10)*

```
SandboxId
  ├─ { kind: "user",   userId, projectRef }        ← default, unchanged
  └─ { kind: "shared", sessionId }                 ← new, only by invitation
```

A shared session is a **first-class row with its own id**, an owner, and an
explicit participant list. It is never inferred from a tuple of things that
happen to match. Its branch is a property of the session, chosen at creation;
`staging` is not a default anywhere.

Behind `sandboxCollaboration` in `organization_settings.flags`, default off —
one line in `OrgFlagsSchema` (`packages/shared/src/organization/schema.ts`) per
the org-flags convention in `CLAUDE.md`. *(R10)*

- **Create:** an owner opens a session on a branch → gets a `sessionId`.
- **Join:** a participant is invited, or joins via a link the owner shares.
- **Attach:** a thread attaches to a `sessionId`. Many threads, many users, one
  session. Attachment is a row, not an overwritten `thread_id` column — that
  column is exactly what made hole 01 a P0. *(R1)*
- **Lifetime:** the session outlives every thread attached to it, and is
  destroyed only by explicit action or by the sweep. *(R1, R12)*

### 2. Actor identity on every request

The daemon currently knows **one** identity: `config.Operator`, a single
last-write-wins field, plus `x-thread-id` used only for org-fs link repointing.
Everything else is anonymous. Attribution is impossible, so is presence, so is
per-writer publish.

Every mutating daemon request carries the actor:

```
x-actor-id:     <userId>
x-actor-name:   <display name>
x-actor-email:  <email>        # for the commit trailer
x-thread-id:    <threadId>     # already sent
```

Read once in middleware (next to `authed`/`linked` in
`daemon-go/main.go`), carried in the request context. Then:

- **Commits** are authored by the actor, not by whoever's token cloned the repo.
  Drop the single-slot co-author trailer. *(R2, R6)*
- **SSE events** carry `actor`, so a client can tell its own echo from someone
  else's write. `file-changed` currently emits `{ path }` only.
- **Presence** becomes possible at all.

This is additive and useful **before** any sharing exists — it works for the
per-user sandbox, and it is independently testable. Ship it first.

### 3. Serialization, in two places

**In the daemon — correctness.** The daemon is the only component that sees every
writer of one tree, so this is where lost-update prevention belongs.
`worktree.Lock` is landed: mutating fs routes and `publish`/`discard`/`rebase`
run under it. Ceiling is documented in the package comment — one lock for the
whole tree, per-path locks if throughput ever shows up in a profile.

**In Studio — ordering across requests.** `withClaimGitLock` is a per-process
`Map`; with N API pods it serializes nothing *(R4)*. It must become a **Postgres
advisory lock keyed on `sessionId`**, and it must cover every mutating proxy
route, not only the git ones — a multi-step sequence (operator `PUT`, then
commit) spans requests and the daemon lock cannot see that it is one unit.

Note what the daemon lock changes: the advisory lock is no longer load-bearing
for single-request data integrity. It is load-bearing for **multi-request
sequences** and for fairness. Say so where it is defined, so nobody later
"optimizes" one of the two away believing the other covers it.

### 4. Change ownership, and a publish that uses it

Once requests carry an actor, the daemon records `path → { actor, at }` on every
write. Bounded: TTL plus a hard cap, evicted like any other cache — the audit's
own lesson about unbounded caches applies to this one too.

That unlocks R2:

```
POST /git/publish { message, paths?: string[] }
```

- `paths` present → stage exactly those, after the existing decofile validation.
- `paths` absent → current whole-tree behaviour (the per-user path, unchanged).
- Paths owned by a **different** actor are reported back, not silently included.

And it powers "Ana is editing `Hero.tsx`" in the UI.

The **shutdown sync** needs deciding explicitly: it currently commits the whole
tree with `InvalidBlockSkip`. For a shared session that is hole 02 at teardown.
Recommendation: on teardown of a shared session, commit per actor — one commit
per owner of the changed paths — or refuse teardown while dirty *(R3)* and make
shutdown-sync a last resort that logs loudly.

### 5. Presence, and the silent-drop bug

`/events` clients are anonymous. Clients declare an actor on connect; the
broadcaster keeps a roster and emits `presence` on join/leave.

Two existing limits become user-visible with N collaborators, and both need
addressing in the same change:

- `MaxSseClients = 100` — a per-pod cap that N users × M tabs now approaches.
- `Broadcaster.fan()` **removes** any client whose 1024-frame buffer is full.
  Today that is an invisible disconnect. With collaborators it must be an
  explicit `resync` signal so the client refetches rather than silently showing
  stale state.

### 6. Credentials

Two cross-identity leaks, both P1, both structural rather than incidental.

**Git.** The access token is baked into the clone URL, so `git clone` persists it
in `.git/config`. Anyone with `bash`, a terminal, or `fs/read` on a shared
sandbox can walk off with another identity's token — and push as them. Fix:
a **git credential helper** that calls back to the control plane with the
*session* token, so the daemon never stores a user's GitHub credential. *(R6)*

**Org-fs.** The mount key is minted as the acting user with a 7-day TTL and is
readable by every participant, and is never revoked — not on stop, not on delete,
not when the minting user loses org access. Fix: mint per session, revoke on
teardown and on membership change. *(R7)*

Also unresolved, and worth deciding rather than inheriting: the in-sandbox tool
catalog is disabled for **all** hosted sandboxes because its endpoint is a
user-bound API key that must not land in a shared workspace. A session-scoped
endpoint fixes it for both models. *(hole 09)*

### 7. Lifecycle

- Teardown refused while another session is attached **or** the tree is dirty;
  the refusal surfaces to the caller. Stop and restart both go through it. *(R3)*
- Transition completion moves out of the SSE `GET` into a worker. A pod must not
  depend on someone reconnecting to finish its own teardown. *(R5)*
- Provisioning is reaped on a **heartbeat**, not a 5-minute wall-clock guess that
  a cold node or a large repo loses. One participant's failed `fs` call must not
  reap the shared session. *(R11)*
- A reconciliation sweep, shaped like the DBOS sweep already running, for
  sessions and pods whose org, thread or vMCP disappeared. *(R12)*
- A ready session returns early instead of re-running `ensure` + re-minting keys
  on every hosted turn. *(R8)*

---

## Sequencing

Ordered by dependency. Each phase is shippable and useful on its own — that is
deliberate, because the first attempt shipped the sharing model before anything
underneath it was ready.

### Phase 0 — landed

- `worktree.Lock` in the Go daemon. Mutating fs routes and
  `publish`/`discard`/`rebase` serialize; a concurrent-`/edit` regression test
  proves it (45 of 50 writes were lost without it).
  Since the TS daemon was deleted, this covers every sandbox in production.

### Phase 1 — identity and attribution *(no sharing yet)*

1. Actor headers, read in daemon middleware, carried in context.
2. Commits authored by the actor; retire the single-slot operator trailer.
3. `actor` on `file-changed` and the other mutation events.
4. Presence roster on `/events`; turn the silent slow-client drop into `resync`.

All of it is exercised by the per-user sandbox, so it ships and soaks without a
flag and without a sharing model.

### Phase 2 — shared sessions, default off

5. `sandboxCollaboration` org flag, default off. *(R10)*
6. `SandboxId.kind: "shared"`, session rows, participant list, attachment rows.
   No overwritten `thread_id`. *(R1)*
7. Postgres advisory lock on `sessionId`, covering every mutating proxy route.
   *(R4)*
8. Teardown guards + the refusal surfaced in the UI. *(R3)*
9. Transition completion in a worker; heartbeat-based provisioning reaper.
   *(R5, R11)*

### Phase 3 — correct multi-writer semantics

10. Change ownership map in the daemon, bounded and evicted.
11. `publish { paths }`, plus the shared-session shutdown-sync decision. *(R2)*
12. Git credential helper — token out of `.git/config`. *(R6)*
13. Session-scoped org-fs keys with revocation; session-scoped tool-catalog
    endpoint. *(R7, hole 09)*
14. Reconciliation sweep. *(R12)*

### Phase 4 — only if measured

15. Soft per-file ownership in the UI ("Ana is editing…").
16. Conflict surfacing when two actors touch one path.

Character-level co-editing stays out until per-file ownership data says people
actually collide.

---

## Verification

Per `TESTING.md`, two tiers, no third.

- **Daemon conformance (`packages/sandbox/daemon-e2e/daemon.*.e2e.test.ts`)** — black-box
  HTTP/SSE, runs against either implementation via `DAEMON_E2E_CMD`. Anything
  new on the daemon's wire surface (actor headers, `publish { paths }`,
  `presence`) gets a test here, and it must pass on **both** daemons. A test that
  only passes on Go is a divergence, not a feature.
- **Studio e2e (`packages/e2e`)** — real Postgres. Every DB assertion is
  tenant-scoped. This is the tier that has to prove the advisory lock actually
  serializes: two concurrent writers, one shared session, assert both writes
  survive.
- **Go unit** — the lock, the ownership map's eviction, the actor parsing.

Explicit test cases the first attempt would have failed, so they are the ones
worth writing first:

1. B deletes their chat → A's sandbox and A's uncommitted tree survive.
2. A is mid-edit, B publishes → A's partial file is **not** in B's commit.
3. A stops while B is attached → refused, and A sees why.
4. Two threads on one session write the same file concurrently → both writes
   survive, serialized.
5. Nobody opens the events stream after a stop → teardown still completes.
6. Two API pods, one session, concurrent publishes → serialized.
7. Flag off → every path routes per-user, exactly as today.

---

## Open questions

- **Branch model.** One shared branch per session means PRs into the default
  branch carry everyone's mixed work. Either protect the session branch and
  define how PRs are cut from it, or keep per-thread branches and share only the
  pod. This was hole 13 and it was never decided. Decide it before Phase 2.
- **Shutdown sync for a shared session** — commit per actor, or refuse teardown
  while dirty and treat shutdown-sync as a loud last resort?
- **Cost.** A shared pod is cheaper than N pods, which makes idle sessions
  attractive to leave running. The idle reaper needs a policy for a session with
  participants attached but nobody active.
- **`bash` and the tree lock.** Accepted as unlockable above. If bash-vs-publish
  interleaving turns out to matter in practice, the escape hatch is a publish
  that refuses while a `bash` task is running, rather than a lock around bash.
