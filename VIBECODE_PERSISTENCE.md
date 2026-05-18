# Vibecode persistence — saving sandbox edits without GitHub

## Context

PR [#3361](https://github.com/decocms/studio/pull/3361) added the **input** half of "vibecode without GitHub": a vMCP can be created from a plain `cloneUrl` (e.g. our `webapp-template`), VM_START accepts it, preview/branch UI treats it the same as an OAuth-linked repo, and the home page has a "Build landing page" tile that fires `VM_START` eagerly.

What it does **not** do is the **output** half: when the sandbox pod goes idle or recycles, every edit the user made is gone, because there's no GitHub remote to push to. Sandbox storage is fully ephemeral — `agent-sandbox` mounts `/app` as `emptyDir` (`deploy/helm/sandbox-env/templates/sandbox-template.yaml:228`); docker/host runners stop the daemon on idle and lose the working tree on the next cold start.

This plan adds a small persistence layer so a vibecoded session survives idle/restart, in both local dev and prod, with no GitHub dependency. The shape is: **on idle, the daemon makes a `git bundle` of the workspace and uploads it to a blob store; on `VM_START`, mesh restores from that bundle (if one exists) instead of re-cloning the template.**

## Scope

In scope:
- A small blob-store abstraction (local FS + S3 IRSA), used only for vibecode bundles.
- A daemon route to create a `git bundle` and stream it out, plus a route to receive a bundle and stage it as a local clone source.
- A mesh-side idle poller that triggers saves.
- A restore pre-step in `VM_START` for `cloneUrl`-backed vMCPs.
- Helm config for the S3 bucket + IRSA role policy.

Out of scope (deferred):
- "Last saved" UI affordance (a follow-up).
- Per-file/incremental sync — full bundle per save is fine at this scale.
- Promote-to-GitHub flow (trivial follow-up once bundle exists: `git remote add gh && git push gh`).
- Collaborative editing / conflict resolution (last-write-wins for MVP; S3 versioning is the safety net).
- A separate vibecode-only bucket per org (single bucket, prefix-multitenant).
- DB table tracking snapshot metadata (S3 `HEAD` response is enough; bucket lifecycle handles GC).

## Architecture overview

```
┌──────────┐                ┌──────────────────────┐                ┌──────────────┐
│  mesh    │                │ sandbox pod (daemon) │                │ blob store   │
│          │                │                      │                │ (S3 / local) │
└────┬─────┘                └──────────┬───────────┘                └──────┬───────┘
     │                                 │                                   │
     │                                 │                                   │
     │ ── poll GET /_decopilot_vm/idle ─►                                  │
     │ ◄─ { idleMs, lastActivityAt } ──                                    │
     │                                                                     │
     │ ── POST /_decopilot_vm/snapshot/create ─►                           │
     │       (daemon: git add -A;                                          │
     │        git commit --amend autosave;                                 │
     │        git bundle create - --all)                                   │
     │ ◄── bundle bytes (stream) ─────                                     │
     │ ──── store.put(key, bytes) ───────────────────────────────────────► │
     │                                                                     │
     │                                                                     │
     │ VM_START:                                                           │
     │ ──── store.head(key) ─────────────────────────────────────────────► │
     │ ◄── { size, etag } | null ─────                                     │
     │ if bundle exists:                                                   │
     │ ──── store.get(key) ──────────────────────────────────────────────► │
     │ ◄── bundle bytes ──────────────                                     │
     │ ── POST /_decopilot_vm/snapshot/stage ─►                            │
     │       (daemon writes bytes to                                       │
     │        /tmp/snapshot.bundle)                                        │
     │ ── POST /_decopilot_vm/config { cloneUrl: "/tmp/snapshot.bundle" } ►│
     │       (daemon's existing orchestrator                               │
     │        runs clone-from-bundle, install, dev)                        │
```

The clever bit: the daemon's existing `setup/orchestrator.ts` already handles `git clone <url>` followed by install+dev. A `.bundle` file IS a valid git remote — `git clone /tmp/snapshot.bundle .` works unmodified. So the restore path **reuses the entire existing clone/install/start machinery**; we just hand it a different URL.

## Components

### 1. Blob store abstraction — `packages/sandbox/server/vibecode-store/`

New small package (or subfolder under `apps/mesh/src/`) with:

```ts
// types.ts
export interface VibecodeStore {
  put(key: string, body: ReadableStream | Uint8Array): Promise<void>;
  get(key: string): Promise<ReadableStream | null>;
  head(key: string): Promise<{ size: number; etag: string } | null>;
  delete(key: string): Promise<void>;
}

// local-fs-store.ts  — writes to <DATA_DIR>/vibecode/<key>
// s3-store.ts        — SigV4 PUT/GET/HEAD/DELETE using IRSA STS creds
// index.ts           — pickStoreFromEnv(): returns S3 if VIBECODE_BUCKET set, else local
```

For `S3Store`: reuse the STS-token refresh pattern proven out in `deploy/helm/studio/templates/configmap-s3-sync.yaml:29-58`. Refresh creds at ~50min, cache in memory (TS module-scope), sign requests with SigV4. We do NOT need the sidecar shell script — we sign in-process from mesh.

**Key format**: `vibecode/<orgId>/<vmcpId>/<branch>.bundle`

### 2. Daemon snapshot routes — `packages/sandbox/daemon/routes/snapshot.ts` (new)

Two handlers, registered in `packages/sandbox/daemon/entry.ts` `vmRouteH()` (~line 434):

```
POST /_decopilot_vm/snapshot/create
  - cd <repoDir>
  - git add -A
  - if any staged changes:
      git commit -m "autosave"  (squashed onto an "autosave" commit by
        amend-if-exists logic, so history doesn't accumulate)
  - git bundle create - --all   (writes bundle to stdout)
  - stream stdout in the HTTP response body
  - returns 204 if there's nothing to bundle (no commits yet)

POST /_decopilot_vm/snapshot/stage
  - reads request body as bundle bytes
  - writes atomically to /tmp/snapshot.bundle (using <name>.tmp + rename)
  - returns 200 { path: "/tmp/snapshot.bundle", size: <n> }
```

Model after `packages/sandbox/daemon/routes/config.ts` for handler shape and auth (daemon-token bearer). Use existing `gitSync` helper from `packages/sandbox/daemon/git/git-sync.ts` for the git commands.

### 3. Mesh idle poller — `apps/mesh/src/sandbox/vibecode-saver.ts` (new)

Runs as a long-lived loop alongside the runner. For each running sandbox managed by the runner:

- Every ~30s, GET `<daemonUrl>/_decopilot_vm/idle` (auth-free per `entry.ts:466`).
- If `idleMs > IDLE_SAVE_THRESHOLD_MS` (default 60s) AND a save hasn't happened since `lastActivityAt`:
  - POST `<daemonUrl>/_decopilot_vm/snapshot/create` with daemon-token bearer.
  - Pipe the response stream to `store.put(<key>, stream)`.
  - Record `lastSavedAt = lastActivityAt` in module-scope memory (per sandboxId) so we don't re-save until the user edits again.
- On runner shutdown (sweep handlers in `apps/mesh/src/sandbox/lifecycle.ts`), trigger one final save for each tracked sandbox.

The key derivation needs the (orgId, vmcpId, branch) — which the runner already tracks per sandbox via `RunnerTenant` (`packages/sandbox/server/runner/agent-sandbox/runner.ts:191`) and the workload's branch.

### 4. Restore step in VM_START — `apps/mesh/src/tools/vm/start.ts`

Insert before line 242 (before the existing `if (githubRepo)` / `else if (plainCloneUrl)` branches):

```ts
// NEW: check vibecode store first
const bundleKey = vibecodeBundleKey(ctx.orgId, virtualMcpId, branch);
const head = await store.head(bundleKey);
let stagedBundlePath: string | null = null;
if (head) {
  // Restore path: download bundle, stage in pod, point clone at it.
  const stream = await store.get(bundleKey);
  // The pod isn't up yet — we'll stage AFTER ensure(), before postConfig().
  // Hold the stream/bytes in memory or in a temp local file keyed by claim.
  pendingBundle = stream;
}
```

Then after `runner.ensure(...)` and before `postConfig(...)`:

```ts
if (pendingBundle) {
  await fetch(`${daemonUrl}/_decopilot_vm/snapshot/stage`, {
    method: "POST",
    headers: { authorization: `Bearer ${daemonToken}` },
    body: pendingBundle,
  });
  // Override the clone URL the orchestrator will see:
  configPayload.git.repository.cloneUrl = "/tmp/snapshot.bundle";
}
await postConfig(daemonUrl, daemonToken, configPayload);
```

The existing orchestrator (`packages/sandbox/daemon/setup/orchestrator.ts:215`) will `git clone /tmp/snapshot.bundle <repoDir>`, install, and start the dev server — no changes there.

### 5. Helm + IRSA

In `deploy/helm/studio/values.yaml`:

```yaml
vibecode:
  enabled: false
  bucket: ""            # required when enabled
  region: "us-east-1"
  prefix: "vibecode"    # final key: <prefix>/<orgId>/<vmcpId>/<branch>.bundle
  retentionDays: 90     # enforced by S3 lifecycle rule, not code
```

The existing `s3Sync.roleArn` IRSA pattern (`configmap-s3-sync.yaml`) is the reference. We add an S3 policy granting `s3:PutObject`, `s3:GetObject`, `s3:HeadObject`, `s3:DeleteObject` on `${bucket}/${prefix}/*` to the mesh ServiceAccount.

A bucket lifecycle rule expires keys after `retentionDays` — that IS the GC. No code needed. S3 versioning enabled at the bucket level provides byte-level safety against last-write-wins clobbering.

## Storage layout

```
S3:    s3://<bucket>/vibecode/<orgId>/<vmcpId>/<branch>.bundle
Local: <DATA_DIR>/vibecode/<orgId>/<vmcpId>/<branch>.bundle
```

Same key, different prefix. The store implementations handle the prefix internally.

## Local vs prod parity

| Concern | Local dev | Prod K8s |
|---|---|---|
| Store backend | `LocalFsStore` | `S3Store` |
| Selector | `VIBECODE_BUCKET` unset | `VIBECODE_BUCKET=xxx` set |
| Auth | none (file perms) | IRSA → STS → SigV4 |
| Save trigger | `vibecode-saver.ts` (same code) | `vibecode-saver.ts` (same code) |
| Save target | `~/deco/services/vibecode/...` | `s3://bucket/vibecode/...` |
| Restore | `store.get` → `/tmp/snapshot.bundle` | `store.get` → `/tmp/snapshot.bundle` |

Mesh code above the `VibecodeStore` interface is identical between envs.

## Key decisions

| Question | Decision | Why |
|---|---|---|
| Format | `git bundle --all` (after squashed autosave commit) | One file. Free history. `.gitignore` already excludes `node_modules`/`.next`. Bundle clones cleanly via standard `git clone` — orchestrator needs zero changes. |
| Where bytes flow | Daemon ↔ mesh ↔ store | Daemon never holds storage credentials. Mesh is the only thing that knows S3 vs local. 5MB bundles through mesh intracluster is trivial. |
| Save trigger | Mesh polls daemon `/_decopilot_vm/idle` every 30s | Daemon already exposes idle; no new daemon-side timer/lifecycle. |
| Save cadence | Only when `idleMs > 60s` and only once per activity burst | Don't waste bandwidth during active typing. |
| GC | S3 bucket lifecycle rule (90d expiry) | Zero code. |
| Multi-tab conflict | Last-write-wins | S3 versioning preserves bytes; rare edge case for MVP. |
| Shallow clone × bundle | Initial template clone uses `--depth 1` today; bundle needs full history | Add `git fetch --unshallow` to first save flow (idempotent — no-op after the first time). |
| Large binaries | Refuse save if bundle > 500MB, warn > 100MB | Bound blast radius; document that real assets need real GitHub. |
| Encryption | SSE-S3 (bucket-level, AWS-managed) | Free, no key management. SSE-KMS deferred. |
| Autosave history | `git reset --soft <root> && git commit -m "autosave"` per save | Single replaceable commit; clean history for future "promote to GitHub". |

## Files to create / modify

**New:**
- `apps/mesh/src/sandbox/vibecode-store/types.ts`
- `apps/mesh/src/sandbox/vibecode-store/local-fs-store.ts`
- `apps/mesh/src/sandbox/vibecode-store/s3-store.ts`
- `apps/mesh/src/sandbox/vibecode-store/index.ts` (+ tests)
- `apps/mesh/src/sandbox/vibecode-saver.ts` (+ tests)
- `packages/sandbox/daemon/routes/snapshot.ts` (+ tests)
- `deploy/helm/studio/templates/configmap-vibecode-policy.yaml` (IRSA add-on if needed)

**Modify:**
- `packages/sandbox/daemon/entry.ts` — register two new routes in `vmRouteH()` (~line 434), add imports near line 266.
- `apps/mesh/src/tools/vm/start.ts` — restore pre-step in `provisionSandbox` (~line 242) + stage call after `runner.ensure` and before `postConfig`.
- `apps/mesh/src/sandbox/lifecycle.ts` — wire shutdown sweep to call the saver's final-save.
- `apps/mesh/src/index.ts` — boot the saver loop alongside the runner.
- `deploy/helm/studio/values.yaml` — `vibecode.*` block.

**Reused (no changes):**
- `packages/sandbox/daemon/git/git-sync.ts` — `gitSync()` helper for bundle/commit commands.
- `packages/sandbox/daemon/setup/orchestrator.ts` — existing clone/install/start machinery handles `cloneUrl: /tmp/snapshot.bundle` unchanged.
- `packages/sandbox/server/daemon-client.ts` `postConfig()` — used to deliver the modified config to the daemon.
- The STS-refresh pattern from `deploy/helm/studio/templates/configmap-s3-sync.yaml:29-58` — port to TS for `S3Store`.

## Implementation order (suggested commit boundaries)

1. **`VibecodeStore` interface + `LocalFsStore`** with unit tests using `tmp` dirs. No mesh/daemon wiring yet. Lands without touching prod.
2. **Daemon `/snapshot/create` and `/snapshot/stage` routes** + daemon e2e test that round-trips a bundle (create → stage → clone-from-bundle).
3. **Restore pre-step in `VM_START`** wired to `LocalFsStore` only. End-to-end test with host runner: clone template → edit → idle → save → kill daemon → restart → restore.
4. **`vibecode-saver.ts` idle poller** + mesh-side shutdown sweep hook.
5. **`S3Store` adapter** behind `VIBECODE_BUCKET` env var; STS-creds refresh ported from the s3-sync configmap pattern.
6. **Helm changes** — values, IRSA policy addition, bucket lifecycle rule docs.
7. **Smoke test in a staging cluster**: provision a Landing-Page agent, edit, wait for idle, kill pod, restart, confirm edits survive.

## Verification (manual + automated)

**Unit / integration (Bun test):**
- `LocalFsStore` round-trip put/get/head/delete with byte-equality assertions.
- `S3Store` against `localstack` (already used elsewhere? check) or a mock SigV4 server.
- Daemon snapshot route: spin up daemon in a tmp dir with a fake git repo, POST `/snapshot/create`, assert response is a valid bundle (`git bundle verify`).
- Daemon stage route: POST a bundle, verify file at `/tmp/snapshot.bundle`, then `git clone /tmp/snapshot.bundle <tmpdir>` succeeds.

**End-to-end (local, host runner):**
1. `bun run dev` with `VIBECODE_BUCKET` unset.
2. Click "Build landing page" on home page.
3. Wait for preview to load, edit `app/page.tsx` via chat, see hot reload.
4. Stop typing for ~90s — check that `<DATA_DIR>/vibecode/<org>/<vmcpId>/<branch>.bundle` appears.
5. `git bundle verify` it.
6. Force-kill the sandbox process / `VM_DELETE`.
7. Re-open the agent → `VM_START` → confirm the previous edits are present in the dev server.

**End-to-end (prod-like, agent-sandbox in a kind cluster):**
1. Set `VIBECODE_BUCKET` + IRSA role, deploy helm chart.
2. Repeat steps 2–7 above; confirm bundle appears in S3 (`aws s3 ls s3://<bucket>/vibecode/...`).
3. Delete the pod (`kubectl delete pod`), trigger `VM_START` from UI, confirm restoration.

**Failure modes to test:**
- Bundle larger than 500MB → save refused with surfaced error, sandbox keeps running.
- S3 PUT returns 5xx → save logged as failure, next idle tick retries.
- Bundle download fails mid-restore → restore aborts, falls through to `cloneUrl` clone path (no data corruption).
- Two browser tabs editing same vMCP → both saves succeed; last write wins; S3 versioning preserves prior version.

## Open questions before code

None blocking — the plan above commits on each decision. If anything below is wrong, flag before step 1:

- Single bucket per env, prefix-multitenant — OK?
- Idle threshold of 60s before first save, poll every 30s — feel right?
- 500MB hard cap on bundle size — OK?
- Save-on-shutdown sweep should happen for **every** running sandbox, even ones with no recent activity, just to be safe — OK?
