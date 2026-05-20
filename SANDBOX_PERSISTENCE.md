# Sandbox persistence — full-state snapshots to S3

> v2 of this proposal. v1 targeted only the `cloneUrl` case and used `git bundle`. After dev review the scope expanded to **every sandbox** and the format switched to plain **`.tar`**. See _What changed from v1_ at the bottom for the diff.

## Context

PR [#3361](https://github.com/decocms/studio/pull/3361) added the **input** half of vibecoding without GitHub: a vMCP boots from a plain `cloneUrl` (e.g. our `webapp-template`), preview tab + branch UI + VM keying treat it the same as an OAuth-linked repo, and the home page has a "Build landing page" tile that fires `VM_START` eagerly.

The matching **output** half is missing — nothing the user does inside a sandbox persists across pod recycles. Today's storage is fully ephemeral:

| Runner | Workdir | Persistence |
|---|---|---|
| `agent-sandbox` (prod K8s) | `/app` is `emptyDir` (4Gi), `/home/sandbox` is `emptyDir` (5Gi) | pod recycle → gone (`deploy/helm/sandbox-env/templates/sandbox-template.yaml:228`) |
| `docker` (local) | container `/app` writable layer | container removal → gone |
| `host` (local dev) | `<DATA_DIR>/sandboxes/<handle>/` | persists on host disk only |

Originally this proposal targeted only the no-GitHub case. After dev review: **the sandbox IS the user's computer. Persist all of it, GitHub or not.** Git push to GitHub remains a user-initiated "publish to upstream" — orthogonal to auto-save of machine state.

Two further dev decisions baked into this version:

- **Format: plain `.tar`** (no `.gz`, no `git bundle`). Stream straight through, zero CPU on compress/decompress. Including `node_modules` means cold-start no longer needs to re-run `npm install` — restore is just untar + boot.
- **Forward direction: Firecracker.** Firecracker is AWS's lightweight microVM tech (what Lambda runs on, what Vercel Sandbox is built on). It supports whole-VM snapshots — memory + disk in <1s. Long-term that's the right shape: capture the entire running computer, restore it instantly. For now, file-level tar works on all our existing runners (host / docker / agent-sandbox / freestyle) without an infra migration. The store interface in this plan is forward-compatible — a firecracker backend would swap the producer/consumer but the abstraction holds.

## Scope

Universal sandbox persistence for **every** running sandbox, regardless of source (GitHub-linked, plain cloneUrl, or future agents):

- A small blob-store abstraction (local FS + S3 IRSA).
- Daemon routes that produce/consume a `.tar` of the workdir.
- A mesh-side idle poller that triggers saves.
- A restore step in `VM_START` for any sandbox with a prior snapshot.
- Helm config for the bucket + IRSA policy.

**What's saved per snapshot:**

- The full workdir (`/app` in agent-sandbox/docker, `<DATA_DIR>/sandboxes/<handle>/app` on host) including `.git`, `node_modules`, build caches.
- Excludes: `./tmp` only (by name). Anything else committed-or-not goes in.
- `/home/sandbox` deferred to v2 (shell history etc., less load-bearing).

**Why include `node_modules`:** restoring it eliminates `npm install` from cold-start. Today's cold start is install-dominated (~10–60s). Restore = untar (5–15s typical) + dev server boots. Big perceived UX win.

## Out of scope (deferred)

- "Last saved" UI affordance.
- Per-file/incremental sync — full tar per save is fine at this scale.
- Promote-to-GitHub flow (works for free once snapshots exist — the restored `.git` carries full local history; `git push gh <branch>` is a one-liner the UI can wire later).
- Collaboration / conflict resolution (last-write-wins; S3 versioning preserves prior bytes).
- DB table tracking snapshot metadata (S3 `HEAD` response is enough).
- Firecracker migration (separate effort; this plan is forward-compatible).

## Architecture

```
┌──────────┐                ┌──────────────────────┐                ┌──────────────┐
│  mesh    │                │ sandbox pod (daemon) │                │ blob store   │
│          │                │                      │                │ (S3 / local) │
└────┬─────┘                └──────────┬───────────┘                └──────┬───────┘
     │                                 │                                   │
     │ ── poll GET /_decopilot_vm/idle ─►                                  │
     │ ◄─ { idleMs, lastActivityAt } ──                                    │
     │                                                                     │
     │ ── POST /_decopilot_vm/snapshot/create ─►                           │
     │       (daemon: tar -cf - -C <workdir>                              │
     │        --exclude=./tmp .)                                           │
     │ ◄── tar bytes (stream) ────────                                     │
     │ ──── store.put(key, stream) ──────────────────────────────────────► │
     │                                                                     │
     │ VM_START (every sandbox, not just cloneUrl):                        │
     │ ──── store.head(key) ─────────────────────────────────────────────► │
     │ ◄── { size, etag } | null ─────                                     │
     │ if snapshot exists:                                                 │
     │ ──── store.get(key) ──────────────────────────────────────────────► │
     │ ◄── tar bytes ─────────────────                                     │
     │ ── POST /_decopilot_vm/snapshot/restore ─►                          │
     │       (daemon: tar -xf - -C <workdir>)                              │
     │                                                                     │
     │ ── POST /_decopilot_vm/config (existing path) ─►                    │
     │       orchestrator sees populated <workdir>                         │
     │       with .git → hasGitRepo() short-circuits clone;                │
     │       existing node_modules → install is a near-no-op;              │
     │       dev server boots.                                             │
     │                                                                     │
     │ if no snapshot: existing PR #3361 path (clone from githubRepo /     │
     │ cloneUrl, then install + start).                                    │
```

The clean reuse: `packages/sandbox/daemon/setup/orchestrator.ts:215` already gates clone on `!hasGitRepo(repoDir)`. When we untar a snapshot into the workdir before the orchestrator runs, it sees the populated `.git` and skips clone. The package manager sees up-to-date `node_modules` and treats install as verify-only. We get free integration with the existing pipeline.

## Components

### 1. Blob store abstraction — `apps/mesh/src/sandbox/sandbox-store/`

```ts
export interface SandboxStore {
  put(key: string, body: ReadableStream | Uint8Array): Promise<void>;
  get(key: string): Promise<ReadableStream | null>;
  head(key: string): Promise<{ size: number; etag: string } | null>;
  delete(key: string): Promise<void>;
}
```

Two adapters:
- `LocalFsStore` — writes to `<DATA_DIR>/sandbox-snapshots/<key>`.
- `S3Store` — SigV4 PUT/GET/HEAD/DELETE via IRSA STS creds, reusing the refresh pattern from `deploy/helm/studio/templates/configmap-s3-sync.yaml:29-58` (ported to TS).

Selected by env: `SANDBOX_SNAPSHOTS_BUCKET` set → S3, otherwise local. Same env-driven shape as the runner kind.

**Key format**: `sandbox-snapshots/<orgId>/<vmcpId>/<branch>.tar`

The same keying applies to GitHub-backed and cloneUrl-backed vMCPs. The branch already comes from the existing vmMap logic generalized in PR #3361.

### 2. Daemon snapshot routes — `packages/sandbox/daemon/routes/snapshot.ts` (new)

Registered in `packages/sandbox/daemon/entry.ts` `vmRouteH()` (~line 434), modeled on the existing `config.ts` handler:

```
POST /_decopilot_vm/snapshot/create
  - cd <repoDir>
  - spawn `tar -cf - --exclude=./tmp .`
  - pipe tar's stdout into the HTTP response body
  - returns 204 if repoDir is empty (nothing to snapshot yet)

POST /_decopilot_vm/snapshot/restore
  - spawn `tar -xf - -C <repoDir>`
  - pipe request body into tar's stdin
  - returns 200 { size, files }
```

Implementation notes:
- Use `node:child_process.spawn("tar", ...)`; stream stdin/stdout to avoid loading the archive in memory.
- Honor the `dropPrivileges` pattern from `packages/sandbox/daemon/setup/spawn-step.ts` (run as `DECO_UID:DECO_GID`).
- Both endpoints require the existing daemon-token bearer (mesh-issued, per claim).

### 3. Mesh idle poller — `apps/mesh/src/sandbox/snapshot-saver.ts` (new)

Long-lived loop alongside the runner. For each running sandbox tracked by `RunnerTenant`:

- Every ~30s, GET `<daemonUrl>/_decopilot_vm/idle` (auth-free per `packages/sandbox/daemon/entry.ts:466`).
- If `idleMs > IDLE_SAVE_THRESHOLD_MS` (default 60s) AND a save hasn't happened since the last `lastActivityAt`:
  - POST `/_decopilot_vm/snapshot/create` with daemon-token bearer.
  - Pipe response stream to `store.put(<key>, stream)`.
  - Record `lastSavedAt = lastActivityAt` in module-scope memory (per sandboxId) so we don't re-save until the user edits again.
- On runner shutdown sweep (`apps/mesh/src/sandbox/lifecycle.ts`), trigger one final save for every tracked sandbox.

Key derivation: orgId + vmcpId + branch — all already on the sandbox record.

### 4. Restore step in VM_START — `apps/mesh/src/tools/vm/start.ts`

Applies to **every** vMCP, not just `cloneUrl`-backed ones. Insert before the existing `if (githubRepo)` / `else if (plainCloneUrl)` branches around line 242:

```ts
const snapshotKey = sandboxSnapshotKey(ctx.orgId, virtualMcpId, branch);
const snapshotHead = await store.head(snapshotKey);
const restoreFromSnapshot = !!snapshotHead;
```

Then after `runner.ensure(...)`, before `postConfig(...)`:

```ts
if (restoreFromSnapshot) {
  const stream = await store.get(snapshotKey);
  await fetch(`${daemonUrl}/_decopilot_vm/snapshot/restore`, {
    method: "POST",
    headers: { authorization: `Bearer ${daemonToken}` },
    body: stream,
    duplex: "half",
  });
  // Orchestrator's existing hasGitRepo() check will detect the restored
  // .git and skip the clone step. We still send the original config so
  // branch checkout / install / start flow correctly.
}
await postConfig(daemonUrl, daemonToken, configPayload);
```

The orchestrator (`packages/sandbox/daemon/setup/orchestrator.ts:215`) handles the rest — populated repoDir → skip clone → install (near-no-op) → start. Zero changes there.

### 5. Helm + IRSA

`deploy/helm/studio/values.yaml`:

```yaml
sandboxSnapshots:
  enabled: false
  bucket: ""
  region: "us-east-1"
  prefix: "sandbox-snapshots"
  retentionDays: 90
```

IRSA policy add: `s3:PutObject`, `s3:GetObject`, `s3:HeadObject`, `s3:DeleteObject` on `${bucket}/${prefix}/*` for the mesh ServiceAccount. Pattern lifted from the existing `s3Sync.roleArn` wiring.

Bucket config:
- Lifecycle rule expires objects at `retentionDays` (no code GC).
- Versioning enabled (last-write-wins safety net).
- SSE-S3 (free, AWS-managed) for encryption.

## Storage layout

```
S3:    s3://<bucket>/sandbox-snapshots/<orgId>/<vmcpId>/<branch>.tar
Local: <DATA_DIR>/sandbox-snapshots/<orgId>/<vmcpId>/<branch>.tar
```

Same key, different prefix. Adapters wrap the prefix internally.

## Local vs prod parity

| Concern | Local dev | Prod K8s |
|---|---|---|
| Store backend | `LocalFsStore` | `S3Store` |
| Selector | `SANDBOX_SNAPSHOTS_BUCKET` unset | `SANDBOX_SNAPSHOTS_BUCKET=xxx` set |
| Auth | none (file perms) | IRSA → STS → SigV4 |
| Save trigger | `snapshot-saver.ts` (same code) | `snapshot-saver.ts` (same code) |
| Save target | `<DATA_DIR>/sandbox-snapshots/...` | `s3://bucket/sandbox-snapshots/...` |
| Restore | `store.get` → daemon `/snapshot/restore` → `tar -xf` | same |

Code above the `SandboxStore` interface is identical between envs.

## Key decisions

| Question | Decision | Why |
|---|---|---|
| Universal or vibecode-only? | **Universal** — every sandbox saves | Per dev: the sandbox IS the user's computer. GitHub push is orthogonal to machine-state save. |
| Format | **Plain `.tar`** | Per dev. Stream-only, zero CPU on compress/decompress. Includes `node_modules` → no install on restore. |
| Compression | **None** at the tar layer | CPU > storage cost. Rely on S3-side optimization if ever needed. |
| What to save | Full workdir incl `.git`, `node_modules`, build caches | Restore = ready-to-run sandbox, not "needs install first". |
| `/home/sandbox` | Deferred | Bound payload size; shell history is least load-bearing. |
| Save trigger | Mesh polls daemon `/idle` every 30s | Daemon already exposes idle; no new daemon-side timer/lifecycle. |
| Save cadence | Only when `idleMs > 60s`, once per activity burst | Avoid waste during active typing. |
| GC | S3 bucket lifecycle rule (90d) | Zero code. |
| Multi-tab conflict | Last-write-wins, S3 versioning preserves bytes | Acceptable for MVP. |
| Large workspaces | Soft-warn > 500MB, refuse > 2GB | Bound blast radius. |
| Encryption | SSE-S3 (bucket-level) | Free, AWS-managed. KMS deferred. |
| Forward arch | **Firecracker** snapshots — whole-VM, sub-second restore | Long-term direction. `SandboxStore` interface is forward-compatible. |

## What changed from v1 (vibecode-only, bundle-based) of this doc

| v1 | v2 (this version) |
|---|---|
| Vibecode-only (cloneUrl) | **Universal** (every sandbox) |
| `git bundle` | **`.tar`** |
| Smaller payload, free history | Larger payload, **fast cold start (no install on restore)** |
| Restore fed bundle path as `cloneUrl` to orchestrator | Restore writes files directly; orchestrator's `hasGitRepo` check short-circuits clone |
| Name: `VibecodeStore` | Name: **`SandboxStore`** |
| Doc: `VIBECODE_PERSISTENCE.md` | Doc: **`SANDBOX_PERSISTENCE.md`** |

## Files to create / modify

**New:**
- `apps/mesh/src/sandbox/sandbox-store/types.ts`
- `apps/mesh/src/sandbox/sandbox-store/local-fs-store.ts`
- `apps/mesh/src/sandbox/sandbox-store/s3-store.ts`
- `apps/mesh/src/sandbox/sandbox-store/index.ts` (+ tests)
- `apps/mesh/src/sandbox/snapshot-saver.ts` (+ tests)
- `packages/sandbox/daemon/routes/snapshot.ts` (+ tests)

**Modify:**
- `packages/sandbox/daemon/entry.ts` — register two new routes in `vmRouteH()` (~line 434).
- `apps/mesh/src/tools/vm/start.ts` — snapshot-restore pre-step in `provisionSandbox` (~line 242) + restore call after `runner.ensure` and before `postConfig`. Applies to ALL vMCPs (no `githubRepo` / `cloneUrl` gating).
- `apps/mesh/src/sandbox/lifecycle.ts` — shutdown sweep → final save for every tracked sandbox.
- `apps/mesh/src/index.ts` — boot the saver loop alongside the runner.
- `deploy/helm/studio/values.yaml` — `sandboxSnapshots.*` block + IRSA policy addition.

**Reused unchanged:**
- `packages/sandbox/daemon/setup/orchestrator.ts` — `hasGitRepo(repoDir)` at line 215 short-circuits clone when we've pre-populated the workdir.
- `packages/sandbox/daemon/install/install-state.ts` — install runs but the package manager treats it as up-to-date when `node_modules` matches the lockfile.
- `packages/sandbox/server/daemon-client.ts` `postConfig()` — delivers config to daemon as today.
- The STS-refresh pattern from `configmap-s3-sync.yaml:29-58` — ported to TS for `S3Store`.

## Implementation order (suggested commit boundaries)

1. `SandboxStore` interface + `LocalFsStore` + tests. No mesh/daemon wiring yet. Lands without touching prod.
2. Daemon `/snapshot/create` and `/snapshot/restore` routes + e2e test (round-trip a populated workdir).
3. Restore step in `VM_START` wired to `LocalFsStore` only. End-to-end test with host runner.
4. `snapshot-saver.ts` idle poller + mesh-side shutdown-sweep hook.
5. `S3Store` adapter with IRSA STS refresh.
6. Helm changes — values, IRSA policy, bucket lifecycle/versioning docs.
7. Staging smoke test.

## Verification

**Unit / integration (Bun test):**
- `LocalFsStore` round-trip put/get/head/delete with byte-equality assertions.
- `S3Store` against `localstack` or a mock SigV4 server.
- Daemon snapshot routes: populate a temp workdir → POST `/create` → verify response is a valid tar → blow away workdir → POST `/restore` → verify all files match by hash.

**End-to-end (local, host runner):**
1. `bun run dev` with `SANDBOX_SNAPSHOTS_BUCKET` unset.
2. Click "Build landing page" (or any GitHub-backed agent).
3. Wait for preview, edit a file via chat.
4. Stop interacting for ~90s → check `<DATA_DIR>/sandbox-snapshots/.../<branch>.tar` exists.
5. `tar -tf` it — should list project files including `node_modules` and `.git`.
6. `VM_DELETE` or force-kill the daemon.
7. Re-open the agent → confirm previous edits present in the dev server within ~5s (no install).

**End-to-end (prod-like, agent-sandbox in a kind cluster):**
1. Set bucket + IRSA role; deploy helm chart with `sandboxSnapshots.enabled=true`.
2. Repeat steps 2–7; confirm tar appears in S3 (`aws s3 ls s3://<bucket>/sandbox-snapshots/...`).
3. `kubectl delete pod`; trigger `VM_START` from UI; verify restoration.

**Failure modes to test:**
- Tar > 2GB → save refused with surfaced error, sandbox keeps running.
- S3 PUT 5xx → save logged as failure, next idle tick retries.
- Restore mid-stream failure → daemon clears partial files, falls through to fresh clone path.
- Two browser tabs editing same vMCP → both saves succeed; last write wins; S3 versioning preserves prior version.

## Open questions

Listed for the implementing dev to call before code:

1. Single bucket per env, prefix-multitenant — or per org? (Recommend single.)
2. Idle threshold of 60s before first save, poll every 30s — feel right?
3. 2GB hard cap on tar size — OK?
4. Include `/home/sandbox` in v1, or defer? (Recommend defer.)
5. Should restore skip the daemon's install step entirely when an `node_modules` tree is restored, to save the ~1–2s package-manager verification? (Optional micro-optimization.)
