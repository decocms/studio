# Unified harness/sandbox transport + message offload-by-reference

- **Status:** Draft (design, pending review)
- **Date:** 2026-06-02
- **Author:** gimenes (with Claude)
- **Related:** PR #3630 (response-leg chunk splitting), `docs/superpowers/plans/2026-06-01-nats-payload-fragmentation.md`

## 1. Problem

Running claude-code (and codex) on a **remote `user-desktop` sandbox** intermittently fails with `Error: MAX_PAYLOAD_EXCEEDED`. This is a NATS server error: the default `max_payload` is **1 MiB**, and `nc.publish` throws it *synchronously* when a single message exceeds it. No override exists in the embedded dev server, docker-compose, or helm (default 1 MiB everywhere).

The failing publish is the **request leg** at `apps/mesh/src/links/dispatcher.ts:133`: the full request frame — carrying the serialized `HarnessStreamInput` (the windowed conversation history `messages[]`, plus models/mcp config) — is published unguarded to the shared subject `links.dispatch.<userSub>`. The in-code comment at `:147-148` already names this the open follow-up: *"a request body over max_payload (follow-up F1 will chunk these)."*

PR #3630 (commit `a24b0b31d`, merged) fixed only the **response leg** (sandbox→mesh SSE chunks) by splitting oversized `chunk` frames via `apps/mesh/src/nats/payload-chunking.ts` (`splitChunkData`, `MAX_PUBLISH_BYTES = 768*1024`). The request leg remains unguarded — that is the live bug.

Size driver (confirmed): the request body is `materializedMessages` — the window (`DEFAULT_WINDOW_SIZE = 50` messages, **count-bounded, not byte-bounded**) with file/image parts already rewritten to short presigned URLs by `resolveStorageRefs`. The dominant growth is **accumulated inline text** (prior tool-call/tool-result outputs) and base64 images when object storage is absent. 50 messages of large tool outputs easily clears 1 MiB; a single big paste can do it alone.

## 2. Goals

1. **Fix `MAX_PAYLOAD_EXCEEDED`** on the request leg — structurally, not by raising the NATS limit (the body is byte-unbounded).
2. **Unify how harness/sandbox systems send & receive messages**: collapse the one cluster→daemon abstraction that bypasses the shared seam (`SandboxProvider.proxyDaemonRequest`) so *all* cluster→daemon traffic flows through one mechanism.
3. Bound the fix to a tractable, reviewable scope; defer the unsafe/unneeded refactors.

## 3. Non-goals (explicitly out of scope)

- **No request-body chunking fallback.** If a body is oversized and offload is impossible, **throw a clear error** — never chunk, never inline-degrade.
- **No generic transport-level offload** for fs/exec/git request bodies (offload is scoped to the harness-dispatch `messages` field — the actual bug).
- **No unified cancel/error model across transports** (see §11 — there is no lossless mapping).
- **No merge of the two 768 KiB chunkers** (see §11 — they are not interchangeable).
- **No carrying of the preview/Vite-HMR WebSocket** over the dispatch transport. Preview/HMR keeps its existing separate plane (k8s: mesh `preview-proxy` direct WS bridge to the daemon URL; desktop: local `<handle>.localhost:<port>` ingress). The dispatch transport carries request/response + SSE only.

## 4. Current architecture (for reference)

| System | Transport to the daemon | Payload limit |
|---|---|---|
| decopilot harness | in-process (`localDispatch`) | none (never serialized) |
| claude-code/codex, `runsIn=cluster` | in-process (`localDispatch`) | none |
| claude-code/codex, `runsIn=user-desktop` | **NATS link** (`remoteDispatch` → raw `DispatchFn`) | **request leg unguarded → the bug** |
| AgentSandbox (k8s) — fs/exec/dispatch | HTTP fetch (port-forward / Service DNS) | none |
| Desktop (user-desktop) — fs/exec/ops | NATS link (`proxyDaemonRequest` → `DispatchFn`) | request leg unguarded |

**The seam:** `SandboxProvider.proxyDaemonRequest(handle, path, init): Promise<Response>` (`packages/sandbox/server/provider/types.ts`) is transport-agnostic and already used by nearly every cluster→daemon call (fs, git, config, exec, preview, events). The **one outlier** is harness dispatch: `remoteDispatch` (`apps/mesh/src/harnesses/remote-dispatch.ts`) calls the raw `DispatchFn` (`apps/mesh/src/links/dispatcher.ts`) directly, creating a second competing abstraction over the same NATS transport. The bug lives on the abstraction that skipped the seam.

**SSE clarification:** the daemon's SSE endpoints (`/dispatch`, `/events`, `/tasks/:id/stream`) are plain HTTP `text/event-stream` responses (`packages/sandbox/daemon/entry.ts` only upgrades to a WebSocket for non-`/_sandbox` paths). On desktop they ride the link control WS as `chunk` frames; on k8s they are a `fetch` streaming `Response`. They do **not** use the preview `ws-proxy` machinery.

**NATS delivery semantics:** `links.dispatch.<userSub>` is **core NATS — fire-and-forget, at-most-once, no JetStream/ack/redelivery**. A dropped request frame is not redelivered; it surfaces as the dispatcher's first-reply timeout. The design must not assume redelivery.

## 5. Design overview

Two independent changes, shipped together:

- **Part A — Unify the seam:** migrate `remoteDispatch` to call `provider.proxyDaemonRequest(handle, "/dispatch", …)`; `DispatchFn` becomes a private implementation detail of `DesktopSandboxProvider`.
- **Part B — Offload `messages` by reference:** at the mesh dispatch layer, if the serialized body would exceed the budget, write the `messages` array to object storage and replace it with a small `{ $ref }` envelope inside the dispatch JSON; the daemon's `/dispatch` route fetches and splices it back before running the harness.

Plus the supporting work: object storage as a hard dependency (§8), cleanup/lifecycle (§9), security (§10), and the reduced "C cleanups" (§11).

## 6. Part A — Unify on `proxyDaemonRequest`

**Change:** `remoteDispatch` calls `provider.proxyDaemonRequest(handle, "/dispatch", { method: "POST", headers, body })` instead of the raw `DispatchFn`, and consumes the returned `Response.body` stream. `DispatchFn`/`createDispatcher` stays, but becomes private to `DesktopSandboxProvider`.

**Two contracts that MUST be preserved (red-team blockers):**

1. **Error/status contract.** `DesktopSandboxProvider.proxyDaemonRequest` 502-wraps a *pre-`headers`* dispatch failure into a `Response { status: 502, body: { error } }`, and `controller.error`s a *post-`headers`* failure. Today `remoteDispatch` *throws* on dispatch error, which `dispatch-run` surfaces as a failed run + persisted error message. The migrated consumer **MUST**:
   - check `Response.status` and, on non-2xx, read + rethrow the JSON error body **before** any SSE parsing (otherwise a 502 body has no `data:` lines → silent empty stream → a failed run that *looks* successful);
   - rethrow on mid-stream `Response.body` error;
   - only tail-flush the SSE buffer on a clean EOF.

2. **UTF-8 / SSE-delimiter integrity.** `splitChunkData` slices the response by UTF-16 code units, so a multi-byte UTF-8 sequence — or the `\n\n` SSE delimiter — can land across two NATS chunks. The new `Response.body` consumer **MUST** use a *single* streaming `TextDecoder` (`decoder.decode(value, { stream: true })`) over the whole stream and concatenate into a buffer before scanning for `\n\n` (mirroring `control-handler.ts`'s existing decode loop). A fresh per-chunk decoder would corrupt JSON.

**Cancellation** is unchanged: caller abort still publishes `{type:cancel}` on `links.cancel.<userSub>` (via the provider's iterator teardown), which aborts the loopback fetch; the per-handle daemon's `DELETE /_sandbox/runs/:runId` + 60 s tombstone still handles the cancel-before-dispatch race.

## 7. Part B — Offload `messages` by reference

### 7.1 Encode (mesh dispatch layer)

In the harness-dispatch path (`dispatch-run.ts` / `remoteDispatch`, which already hold `ctx.objectStorage` and `input.organizationId`), before serializing the request body:

1. Compute the encoded body size. If it is **within** the budget (`MAX_PUBLISH_BYTES = 768*1024`), send inline as today (the common case — **no storage access**).
2. If it **exceeds** the budget:
   - Require the resolved daemon to advertise the **`body-offload` capability** (§7.3). If absent → throw a clear error (`"remote sandbox daemon is too old to receive large requests"`).
   - Require real fetchable object storage (§8). If absent → throw a clear error (`"request too large and no object storage is configured for large payloads"`).
   - PUT `JSON.stringify(messages)` to object storage under key `link-dispatch/<reqId>` (the org segment is implicit — `BoundObjectStorage` already prepends `<orgId>/`). Private bucket, SSE enabled.
   - Mint a presigned GET URL with `presignedGetUrl(key, { requireFetchable: true })` (§8.3) and a **~10-minute** TTL.
   - Replace `input.messages` with an envelope: `{ $offloadedMessages: { url, bytes, sha256 } }` and serialize the (now small) body.

Only `messages` is offloaded; `models`, `mcp` (incl. the bearer temp key), and `virtualMcp` stay inline — secrets never reach object storage.

### 7.2 Re-inflate (daemon `/dispatch` route)

`handleDispatchRequest` (`packages/sandbox/daemon/routes/dispatch.ts`):

1. **Flush the SSE `200`/`text/event-stream` response headers immediately**, before any ref fetch — this satisfies the dispatcher's first-reply timer (the `headers` frame arrives promptly via `control-handler.handleStream`). The ref fetch and harness run happen inside the response `ReadableStream`.
2. Parse the body. If `input.$offloadedMessages` is present, `fetch` the URL under the guards in §10.2, validate size/`sha256`, splice the recovered `messages` back into `input`, then run the harness.
3. If the ref fetch fails (network, 4xx/5xx after bounded retry, size cap exceeded), emit an SSE `error` event (which becomes a `{type:error}` frame) — **never** hang.

Other daemon routes (fs/exec/git) are unchanged. The generic transport (`control-handler`, dispatch-frames) is unchanged — no `bodyRef` frame field.

### 7.3 Capability gate (red-team blocker — offload MUST NOT ship without it)

`requestFrame` is an open `z.object`, so an unknown field is silently stripped by `decodeFrame` and an old daemon would reverse-proxy an empty/garbled body. Therefore offload is gated on an explicit capability:

- Add `"body-offload"` to the link `hello` capabilities. `ws-gateway.ts` already persists `hello.capabilities`.
- **Caution:** `capabilitySchema` (`apps/mesh/src/links/protocol/schemas.ts`) is a closed `z.enum([...]).catch([])` — a single unknown element nukes the *entire* capabilities array. Extend it to tolerate unknown values **per element** (e.g. parse each entry independently / use a permissive element schema) so adding `"body-offload"` does not blank out existing capabilities during version skew.
- The cluster reads the resolved daemon's advertised capabilities (from the link claim) and offloads only when `body-offload` is present. Otherwise the oversized-body error path in §7.1 applies.

## 8. Object storage as a hard dependency

### 8.1 Requirement

Real, fetchable object storage is **required** for oversized payloads. There is no chunking fallback.

- **Prod:** S3/R2 (public endpoint).
- **e2e:** MinIO (already configured — `.github/workflows/e2e.yml`, `S3_ENDPOINT=http://localhost:9000`, bucket `studio-e2e`).
- **Local dev:** MinIO, **auto-provisioned** by `apps/mesh/src/services/ensure-services.ts` (mirroring the existing `nats-server` binary download + spawn pattern), including bucket creation and the lifecycle rule (§9). `bun run dev` brings it up like Postgres/NATS.

### 8.2 Self-host constraint (documented)

The presigned URL is fetched **on the user's machine** (the link control-handler runs there). A cluster-internal/`localhost` storage endpoint is unreachable from a remote laptop. Therefore offload-by-reference for the remote link requires object storage with a **daemon-reachable (public) endpoint**:

- Local dev works because mesh, MinIO, and the link daemon are all on the same host (`localhost` is reachable).
- Prod works because S3/R2 endpoints are public.
- **Self-host operators MUST expose object storage on a publicly reachable endpoint** for remote-link offload. The presign targets the storage `publicUrlBase` (already supported in `apps/mesh/src/file-storage/file-config-s3.ts`), not the internal endpoint.

### 8.3 `requireFetchable` presign option (preserves vision behavior)

The dev "inline as a `data:` URL" behavior exists because remote vision models reject `localhost` URLs. We must **not** change that default, and the predicate is **"is the storage endpoint loopback/private,"** not "remote-model reachability" (no such signal — all model adapters hit public endpoints).

- Add `presignedGetUrl(key, { requireFetchable?: boolean })`.
- **Offload** calls it with `requireFetchable: true` → always a real fetchable URL; if the only option is a `data:` URL (DevObjectStorage with no real endpoint), it throws.
- **Vision / `GET_PRESIGNED_URL` / `copy_to_sandbox` / `legacyMaterialize` / `take-screenshot` / `prepareStep`** keep today's default behavior unchanged.
- Detect "no real presigned storage" by **type** (real `S3Service` present in the context factory vs `DevObjectStorage`) up front — do not sniff a `data:` URL (which would force base64-encoding the whole blob first).

## 9. Cleanup & lifecycle

- **Primary reclaimer = bucket lifecycle TTL.** A lifecycle rule on the ephemeral prefix (matching `*/link-dispatch/` to account for the implicit `<orgId>/` prefix) expires objects after **~24 h** (S3 lifecycle minimum granularity is 1 day). This is the real guarantee.
- **Eager delete is best-effort and only on terminal `end`/`error`** of the dispatch — **never** on caller-abort or first-reply-timeout (those race an in-flight daemon fetch → 403/404 → confusing error). The TTL net covers anything not eagerly deleted.
- **Presign TTL ~10 min** — bounds the usable window (well above worst-case PUT→daemon-fetch-start, including one reconnect window). Since secrets are not offloaded (§7.1), the object holds only conversation history; the short presign + private bucket + TTL backstop are sufficient.
- **Key:** `link-dispatch/<reqId>` (org implicit). A higher-layer retry mints a new object; the daemon's `runId` tombstone dedups the *run*, and the TTL reclaims the orphaned object — acceptable and documented.

## 10. Security

- **Tenant isolation:** `ctx.objectStorage` (`BoundObjectStorage`) is org-bound and prepends `<orgId>/`; assert `input.organizationId` equals the bound storage org (defense-in-depth, since the link is authenticated by `userId`, not org).
- **No secrets at rest:** only `messages` is offloaded; `mcp.headers` (bearer temp key), `mcp.expiresAt`, and `models.credentialId` stay inline.
- **SSRF guards on the daemon fetch (§7.2):** the daemon validates the ref URL against a **host allowlist shipped via the `hello`/config channel (never trusted from the frame)**; `redirect: "manual"` (reuse the existing loopback-fetch posture); reject non-HTTPS and RFC1918/link-local/loopback hosts **except** an explicitly documented same-host dev MinIO; reject `data:` defensively; enforce a hard byte cap (bound to a realistic max harness-input size, not 500 MiB) + `content-length` check + wall-clock deadline (mirroring `fs.ts` `write_from_url`); bounded retry on retriable 5xx/network via `@decocms/std` `retry` with `isRetriable`.
- **No leakage in logs/traces:** never log the frame body, headers, or the signed `bodyRef` URL; OTel span attribute is the object **key**, not the signed URL; redact query strings.
- **Bucket posture:** require block-public-access + server-side encryption at provision time.

## 11. Reduced "C cleanups" (the safe versions)

The red-team established (with code evidence) that the originally-scoped C cleanups are unsafe or pointless. This spec includes only their safe reductions:

- **Delete dead `exec`.** `SandboxProvider.exec()` has **zero production callers**, and the two impls deliberately diverge (agent-sandbox: 401-stale-token retry; desktop: throws-on-non-2xx + typed `ExecOutput`). Do **not** fold it into `proxyDaemonRequest` (that silently changes the error contract and drops the retry). Instead **remove** `exec`/`ExecInput`/`ExecOutput` (knip will confirm no callers), or leave untouched if removal is noisy.
- **Shared error-code enum only.** A thin shared enum of terminal error codes that each transport maps *into* where meaningful. Do **not** attempt a unified cancel model: the link has four terminal signals others lack (`error`, `ws_closed`, `publish_failed` with delivered-gating, the 30 s first-reply timeout) and two differently-keyed cancel channels (`links.cancel` by `reqId` vs `DELETE /runs/:runId` by `runId` + 60 s tombstone). Collapsing them risks orphaning desktop harnesses — the exact bug the tombstone fixed.
- **Shared `MAX_PUBLISH_BYTES` constant only.** Export `MAX_PUBLISH_BYTES = 768*1024` from `apps/mesh/src/nats/payload-chunking.ts` as the single shared budget. Do **not** merge the two chunkers: `splitChunkData` (ordered substrings, no metadata — correct for single-subject core NATS) and `nats-stream-buffer` (`Dp-Frag-Idx/Total` + reassembly + 32 MiB cap — correct for JetStream tail consumers) are not interchangeable; merging corrupts one. Keep both impls, cross-referenced.

## 12. Failure modes

| Failure | Result |
|---|---|
| Body ≤ budget | Inline as today; no storage access. |
| Body > budget, daemon lacks `body-offload` | Clean error: "daemon too old for large requests"; run fails fast. |
| Body > budget, no real fetchable storage | Clean error: "no object storage for large payloads"; run fails fast (ideally also fail-fast at boot with an actionable message). |
| S3 PUT fails (encode) | Clean error to the caller; run fails; nothing published. |
| Request frame dropped (no live claim, core NATS at-most-once) | Dispatcher first-reply timeout → throws; orphaned object reclaimed by TTL. |
| Daemon ref fetch fails / times out / exceeds cap | Daemon emits SSE `error` → `{type:error}` frame; run fails cleanly; no hang. |
| Presign expires before fetch | Same as fetch failure (clean error). Mitigated by ~10 min TTL ≫ expected latency. |
| Caller abort mid-fetch | Cancel propagates; no eager delete (TTL reclaims); no 403-race. |
| Slow large-body download | First-reply timer already satisfied by the early SSE headers flush; download proceeds inside the stream. |

## 13. Backward compatibility / rollout

- Gated entirely by the `body-offload` capability (§7.3): mixed-version clusters/daemons never offload to a daemon that can't re-inflate.
- The `capabilitySchema` change must be deployed such that an old daemon advertising only legacy capabilities still parses correctly (per-element tolerance), and a new daemon advertising `body-offload` to an old cluster is simply ignored.
- Part A (the `proxyDaemonRequest` migration) is internal to mesh and does not change the wire protocol; verify the error/status + UTF-8 contracts (§6) so `dispatch-run`'s observable behavior is identical.

## 14. Testing

**Unit (`bun test`, pure logic):**
- Offload decision: size threshold boundary; envelope shape; `requireFetchable` throws on `data:`-only storage.
- `capabilitySchema` per-element tolerance: unknown element does not blank the array.

**E2E (Playwright, real Postgres + NATS + MinIO):**
- **Oversized dispatch round-trips** via offload (messages > budget) on the user-desktop link → run succeeds, output intact.
- **Pre-body dispatch error** → failed run + persisted error message (guards the silent-empty-stream regression in §6).
- **UTF-8 SSE event split across two NATS chunks** → byte-exact reassembly.
- **Daemon lacks `body-offload`** + oversized body → clean error, no empty body sent.
- **SSRF:** a ref URL pointing off-allowlist is rejected by the daemon.
- **No real storage** + oversized body → clean error (fail-fast).

## 15. Follow-ups (deferred)

- Generic transport-level offload for fs/exec/git request bodies (not the bug; revisit if those exceed limits).
- Full cross-transport cancel/error normalization (no lossless model today).
- Chunker consolidation beyond the shared constant.
- `resolveRemoteCliSandboxHandle` preview-coupling cleanup (pre-existing).
- F4 stopgap (raise NATS `max_payload`) — not pursued; the body is byte-unbounded.

## 16. Open risks

- **S3 lifecycle 1-day minimum** means the orphan backstop is coarser than the ~10 min presign; acceptable because eager terminal-delete covers the happy path and the blob holds no secrets.
- **Auto-provisioning the MinIO binary cross-platform** in `ensure-services.ts` needs validation against the `nats-server` download/spawn pattern (platform/arch artifacts, bucket + lifecycle bootstrap on first run).
- **Daemon-reachable storage in self-host** is an operator responsibility (§8.2); the docs and a startup check should make the requirement loud.
