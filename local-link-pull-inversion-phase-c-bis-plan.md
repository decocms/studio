# Local-Link Pull Inversion — Phase C-bis (Sandbox Reverse-Proxy → Pull) — HARDENED PLAN

> v2 (2026-06-06): hardened by an adversarial design review (distributed/multi-pod, reuse-vs-rewrite, streaming-correctness, goal/scope critics + resolver). **Status: APPROVED to implement — user said "continue to the end".** The v1 §5.1 "in-memory per-pod queue keyed by reqId" was a multi-pod data-loss bug and is REPLACED by the two-subject NATS correlation in §3b below.

## 1. The reframing (grounding workflow established)
1. **Desktop preview already bypasses the WS.** `DesktopSandboxProvider` has no `proxyPreviewRequest`; the browser hits `http://<handle>.localhost:<ingressPort>` served by the daemon's in-process `local-ingress.ts` (Bun.serve HTTP+WS proxy w/ Vite-HMR). The only cluster coupling (the ingress port) is already on the `x-link-preview-port` presence header. **Preview = zero work.**
2. **Everything else funnels through ONE method** — `DesktopSandboxProvider.proxyDaemonRequest` → `this.dispatch(userSub,…)`: vm-events SSE, the `/_sandbox` control RPC family, and decopilot vm-tools. Rehome that one method and all three move.

## 2. Traffic table (desktop)
| WS traffic | Today | Pull home | Effort |
|---|---|---|---|
| Preview iframe | browser→local-ingress (never WS) | unchanged | none |
| Preview-port signal | WS hello | `x-link-preview-port` header | done |
| Chat dispatch | `remoteDispatch`/WS | work-poll→ingest | done |
| Cancel | `links.cancel.<userSub>` | control-poll | done |
| vm-events SSE / `/_sandbox` control RPC / vm-tools | `proxyDaemonRequest`→WS | **new pull reverse-proxy channel (§3b)** | medium |
| ensure/delete/postConfig | `provider.ensure()`→WS | control-poll `ensure_sandbox`/`delete_sandbox` + postConfig over the channel; chat leans on daemon self-ensure | medium |
| warm-ensure (`resolveRemoteCliSandboxHandle`) | `ensureSandbox(…,'user-desktop')`→WS | **surgical** sever — pure `computeHandle` at the 2 dispatch sites; the preview-URL site needs an explicit ensure | small |

## 3. Topology
- **Desktop preview:** browser→local-ingress direct (status quo). Do NOT re-introduce a cluster proxy. Auth unchanged (open-by-handle on both). Zero code.
- **Cloud preview:** unchanged (browser→cluster preview-proxy→pod:9000). Never used WS.
- **Desktop `proxyDaemonRequest` (events+control+vm-tools):** the new pull reverse-proxy channel (§3b).

## 3b. HARDENED correlation design (replaces v1 §5.1 — the crux)
Two core-NATS subjects derived **purely from ids** — the SAME subscription-interest routing `ws-gateway.ts:368` uses today, re-expressed behind the long-poll. No per-pod in-memory map; no LB affinity assumption.

- **REQUEST leg (cluster→daemon):** `proxyDaemonRequest` on originating pod Y publishes the `RequestFrame` to per-user subject `links.proxy.req.<userSub>`. The daemon's `GET /api/:org/links/proxy` long-poll subscribes to it on LB-assigned pod X (mirror `link-control-routes.ts` `nc.subscribe({max:1})` + 28s window). **CORE NATS, not JetStream.** **CRITICAL:** the daemon must hold the GET open with **continuous overlap** (re-issue the next GET before the prior returns) — core NATS is no-op-if-no-subscriber, so a request published into an unsubscribed gap is silently dropped → vm-tools hang → probeHealth fails → cold-spawn thrash. Forbid the naive poll/204/re-poll loop on this leg.
- **REPLY leg (daemon→cluster, streaming):** reply subject derived purely from reqId: `links.proxy.reply.<reqId>`. Pod Y subscribes BEFORE publishing the request (no first-frame race). The daemon streams its framed reply via `POST /api/:org/links/proxy/:reqId/stream` as a `duplex:'half'` upload (handle-local-dispatch.ts pattern). That POST lands on ANY pod Z; pod Z stream-consumes `c.req.raw.body` frame-by-frame **without buffering** (link-ingest-routes.ts createTailStream+pump; never `await c.req.text()`) and core-NATS-publishes each decoded `DispatchChunk` to `links.proxy.reply.<reqId>`. NATS routes every frame to pod Y regardless of which pod got the POST → **pod Z needs zero shared state** (subject computed from the URL param). Headers frame flushed before first body chunk (runner.ts:255 depends on it).
- **CANCEL leg:** `links.proxy.cancel.<reqId>`. `runner.ts` `ReadableStream.cancel()` publishes it; the GET-owning pod forwards to a daemon-side **reqId→AbortController registry** (mirror `run-abort-registry`, keyed by **reqId** not runId — one run opens many reqIds: events SSE + N vm-tools). Must release `handleStream`'s reader, run `acquireDispatch`'s release (control-handler.ts:173,249 — only fires on iterator end, and `/events` never ends, so cancel is the ONLY thing freeing the daemon SSE slot / `MAX_SSE_CLIENTS=100`).
- **FAIL-FAST:** dispatcher has no idle timeout after first frame → vanished daemon hangs pod Y forever. Backstops: (1) on proxy-POST/GET drop, owning pod publishes an error frame to outstanding `links.proxy.reply.<reqId>`; (2) on link-claim presence expiry (60s TTL), 502 all in-flight proxy awaiters for the user (cross-pod port of ws-gateway.ts:424-451).
- **REUSE seam:** expose the new channel as a `DispatchFn`/`DispatchChunk`-shaped adapter (the interface at dispatcher.ts:42-61) so `runner.ts` `proxyDaemonRequest`/`dispatchJson`/`probeHealth` only swap the injected `dispatch` impl — streaming/abort/headers code untouched.

## 4. L14 verdict
WS deletable after C-bis IFF: rehome `proxyDaemonRequest` to the channel + ensure/delete via control-poll + repoint `probeHealth` + **surgically** sever the 2 dispatch warm-ensure sites (preview-URL site keeps an ensure) + target-gated cutover. The two-pod **ephemeral NATS reply-INBOX** is removed (spec headline satisfied); **core NATS pub/sub stays** in the reply path (`links.proxy.reply.*`).

## 5. Must-fix landmines (the implementation MUST address every one)
1. SSE reply leg is DUPLEX on BOTH ends: daemon POST `duplex:'half'` streaming upload AND cluster stream-consume frame-by-frame (no `await c.req.text()`), headers flushed first — else `EventSource.onopen` hangs (`/events` never ends).
2. **Detached per-reqId dispatch** on the daemon: dequeue → detached handler → IMMEDIATELY re-poll. Never await the (forever) SSE reply before re-polling, or one preview tab deadlocks all proxy traffic.
3. **reqId-keyed cancel** (not runId) wired runner.ts `ReadableStream.cancel()` → `links.proxy.cancel.<reqId>` → daemon reqId→AbortController registry; verify it frees the SSE slot + runs `release()`.
4. **probeHealth** repoint in the SAME stage as the transport swap; its 1500ms cap is now coupled to dequeue latency — keep on the zero-gap fast path with a justified cap, OR read liveness from the presence claim instead of round-tripping the daemon.
5. **Continuous-overlap request polling** (no unsubscribed gap) — core NATS drops gap-published requests silently.
6. **Target-gated cutover**: `isPull = resolveDispatchTarget().runsIn==='user-desktop'`, NOT `workQueue!=null` (the bug that reddened `40562b383`).
7. **Surgical warm-ensure sever**: `resolveRemoteCliSandboxHandle` has 3 sites — dispatch-run.ts:1152 & :1693 ride work-item self-ensure (safe for pure `computeHandle`); `resolveRemoteCliSandboxUrl` (:1748/:1752) returns a preview URL OUTSIDE the work queue → pure computeHandle 502s an unspawned handle; gate that site on an explicit ensure.
8. **Daemon-vanished fail-fast** (presence-expiry 502 fanout) — dispatcher has no idle timeout after first frame.
9. **DispatchChunk encoding**: `handleStream` yields TextDecoder UTF-8 (control-handler.ts:215,229) but WS DispatchChunk is base64 — pin ONE for the channel (base64 for binary-safe vm-tools file reads) or scope text-only + document binary unsupported.
10. **Multi-org**: `connectToClusterPull` is single-org (TODO) — C-bis widens the blast radius; acknowledge + schedule the per-org-loop follow-up.

## 6. Staged plan (each independently CI-green; dormant until Stage 6 flip)
- **S0 (prereq):** move `DispatchChunk`/`DispatchFn`/`DispatchRequest`/`DispatchHeaders` types out of `dispatcher.ts` into a transport-neutral module (alongside `link-control-types.ts`); dispatcher re-exports. No behavior change. *(Makes "runner.ts untouched" true after dispatcher deletion.)*
- **S1 (cluster, dormant):** `GET /links/proxy` (core-NATS sub `links.proxy.req.<userSub>`, 28s, abort-on-disconnect) + `POST /links/proxy/:reqId/stream` (stream-consume body frame-by-frame, republish each chunk to `links.proxy.reply.<reqId>`, no buffer/no inflight map) + `links.proxy.cancel.<reqId>` plumbing. Unit-test parse/republish + no-buffer consume.
- **S2 (daemon, dormant):** `runProxyPollLoop` continuous-overlap; detached per-reqId handler calling `controlHandler.handleStream`, duplex POST reply; daemon reqId→AbortController registry; pin encoding. Wire into `connectToClusterPull`.
- **S3 (provider adapter behind flag):** `DispatchFn`-shaped adapter over the channel for `proxyDaemonRequest`/`dispatchJson`; **repoint probeHealth** (+ latency handling); ensure/delete via control-poll frames; keep old `dispatch()` selectable. Provider unit tests + pull e2e `/_sandbox/events` round-trip.
- **S4 (surgical warm-ensure sever):** the 3 sites per landmine #7.
- **S5 (fail-fast + cancel correctness + e2e):** presence-expiry 502 fanout; POST/GET-drop error frames. e2e: tab-close-frees-slot, daemon-relink-fails-fast, concurrent events+vm-tools fanout, request-during-gap-not-lost.
- **S6 (target-gated cutover):** `isPull = runsIn==='user-desktop'`; `resolve-provider.ts` routes desktop→pull; cloud→in-cluster. Pull-daemon e2e SIMS (poll `/links/work` + fake harness posts to ingest). Green across e2e+multi-pod.
- **S7 (flip daemon default to pull):** hard break — users re-run `bunx decocms@latest link`.
- **S8 (Phase F deletion):** see §7.

## 7. Phase F deletion scope (under the resolved approach)
**DELETE:** `ws-gateway.ts`(+test), `dispatcher.ts`(+test) [ephemeral reply-inbox gone], `dispatch-frames.ts`(+test) [codec; RequestFrame already rehomed, DispatchChunk types moved in S0], `cluster-connection.ts`(+test), `reconnect-backoff.ts`(+test); app.ts `registerLinksGateway`/`getDispatch`/`sharedDispatch`/`gatewayWsHandlers`; index.ts gateway branches+guard; lifecycle.ts `buildDesktopProvider` + resolve-provider.ts call sites.
**SURVIVES:** `link-claim-registry.ts` (presence + 60s fail-fast), `payload-chunking.ts` (live edge), `control-handler.ts` (handleStream REUSED), `run-registry.ts` reaper, the NEW `links.proxy.*` subjects/routes/`runProxyPollLoop`/reqId registry.

## 8. Honest justification note
The original driver (token-pinning reconnect→chat-timeout) is **already fixed on this branch** (`cluster-connection.ts` resolves a fresh token per reconnect); pull is dormant so chat still rides WS in prod today. C-bis's true justification is **architectural** (outbound-only/firewall-friendly daemon, remove the ephemeral two-pod inbox) — the project's stated north star. A cheaper symptom-only alternative (idempotent mid-stream resume in `remoteDispatch`) fixes mid-turn-drop on BOTH transports but does NOT achieve the architecture, so it is not a substitute. Proceeding with full C-bis per user direction.
