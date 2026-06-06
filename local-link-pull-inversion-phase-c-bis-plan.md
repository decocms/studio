# Local-Link Pull Inversion — Phase C-bis (Sandbox Reverse-Proxy → Pull) Design

> Produced 2026-06-06 by a grounding+design workflow (6 parallel code readers + adversarial completeness audit + synthesis). This is the design that unblocks Phase F (deleting the reverse-WS). Status: **DESIGN ONLY — pending the go/no-go decision (see §6).**

## 1. The reframing (what the workflow established)

Phase F's blocker was "the reverse-WS carries a 6th traffic type with no pull home." The grounding sharpened this into two facts:

1. **Desktop preview already bypasses the WS.** `DesktopSandboxProvider` has **no** `proxyPreviewRequest`. The browser hits `http://<handle>.localhost:<ingressPort>` served by the daemon's in-process `local-ingress.ts` (a full Bun.serve HTTP+WS reverse-proxy with Vite-HMR frame buffering), started *before* the cluster connection. `link-daemon/index.ts` sets the preview URL to that local-ingress URL. The only cluster coupling — telling the cluster the ingress port — is **already** rehomed to the pull path (`x-link-preview-port` presence header, `work-poller.ts:114`). **Preview needs zero C-bis work.**
2. **Everything else funnels through one method.** vm-events SSE (`vm-events.ts`/`sandbox-events-handler.ts`), the `/_sandbox` control RPC family (`sandbox-proxy.ts:proxyDaemon` → `/config`,`/read`,`/write`,`/glob`,`/exec`,`/git/*`,`/setup`), and decopilot **vm-tools** (`built-in-tools/vm-tools/index.ts:daemonRequest`) ALL call `DesktopSandboxProvider.proxyDaemonRequest`, which calls `this.dispatch(userSub, …)` → NATS `links.dispatch.<userSub>` → ws-gateway → daemon. **Rehome that one method and all three move together.**

## 2. Traffic table (desktop)

| WS traffic | Today (desktop) | Pull home | Effort |
|---|---|---|---|
| Preview iframe HTTP/WS | browser → daemon local-ingress (never WS) | unchanged (already local) | none |
| Preview-port signal | WS hello frame | `x-link-preview-port` presence header (done) | none |
| Chat dispatch `/_sandbox/dispatch` | `remoteDispatch` over WS | work-poll → ingest (Phases B/D) | done |
| Cancel | `links.cancel.<userSub>` | control-poll (Phase C) | done |
| **vm-events SSE** | `proxyDaemonRequest` → WS | **new pull reverse-proxy channel** | medium |
| **`/_sandbox` control RPC** | `proxyDaemonRequest` → WS | same channel | (incl.) |
| **vm-tools** (read/write/edit/grep/bash) | `proxyDaemonRequest` → WS | same channel (it *is* `proxyDaemonRequest`) | (incl.) |
| **ensure / delete / postConfig** | `provider.ensure()`/`/_sandbox/config` → WS | control-poll `ensure_sandbox`/`delete_sandbox` frames + postConfig over the channel; chat path leans on daemon self-ensure from the work item | medium |
| **warm-ensure** (`resolveRemoteCliSandboxHandle`) | `ensureSandbox(…,'user-desktop')` → WS (Blocker 3, swallowed "malformed JSON") | sever — derive handle via pure `computeHandle`; daemon self-ensures from `WorkItem.sandbox` | small |

## 3. Recommended end-state topology (split by locality, not traffic type)

- **Desktop preview:** browser → local-ingress **direct** (status quo). Do NOT re-introduce a cluster proxy. Auth unchanged (preview is open-by-handle on both desktop and cloud; the cluster adds no real preview authz today). Lowest latency, full HMR, zero code.
- **Cloud preview:** unchanged (browser → cluster `preview-proxy.ts` → pod:9000; eventually per-claim HTTPRoute). Never used the WS — orthogonal.
- **All desktop `proxyDaemonRequest` traffic (events + control + vm-tools):** a **new pull reverse-proxy channel** — `GET /api/:org/links/proxy` (daemon long-polls one queued request frame) + `POST /api/:org/links/proxy/:reqId/stream` (daemon streams the framed reply). Reuse the **existing** daemon `control-handler.handleStream` (already proxies to `127.0.0.1:<port>/_sandbox/*`) and the **existing** `DispatchChunk`/headers frame shape so `runner.ts` streaming/abort code is untouched. Daemon stays **outbound-only** (firewall-friendly); cluster stays the auth/policy point for privileged control RPC.
- **ensure/delete:** control-poll frames; chat hot path relies on daemon self-ensure from the work item.

## 4. L14 verdict — is the WS deletable after C-bis?

**Yes, IF C-bis scope is exactly:** (a) rehome `proxyDaemonRequest` to the pull reverse-proxy channel; (b) move ensure/delete to control-poll frames; (c) **repoint `probeHealth`** at the new channel (else every cache probe hard-fails post-cutover → sandbox thrash); (d) **sever** `resolveRemoteCliSandboxHandle`'s WS warm-ensure (else CLI-harness config resolution breaks); (e) land the **target-gated cutover** (`isPull = resolveDispatchTarget().runsIn==='user-desktop'`, not NATS-gated — the bug that already turned CI red in `40562b383`). Omit (a)/(c)/(d) and a consumer remains (vm-tools / liveness probes / CLI config resolution respectively).

## 5. Staged plan (each stage independently CI-green, built dormant before flipping)

1. **Reverse-proxy pull channel — cluster side (dormant).** `GET /links/proxy` + `POST /links/proxy/:reqId/stream`; a `ProxyChannel` queue keyed by reqId; reuse `DispatchChunk` framing. No caller → green. Unit-test queue + framing.
2. **Reverse-proxy pull channel — daemon side (dormant).** `runProxyPollLoop` calling the existing `controlHandler.handleStream`, streaming the reply back. Wire into `connectToClusterPull` alongside work+control loops. Green.
3. **New `DesktopSandboxProvider` transport behind a flag.** Re-implement `proxyDaemonRequest`/`dispatchJson`/`probeHealth` onto the channel; ensure/delete via control-poll frames; keep old `dispatch()` selectable. Provider unit tests + a pull e2e driving a full `/_sandbox/events` round-trip.
4. **Sever the warm-ensure (Blocker 3).** Pure `computeHandle`; warm-ensure best-effort/removed (daemon cold-spawns from `WorkItem.sandbox`). Green.
5. **Target-gated cutover (Blocker 1) + pull-daemon e2e simulations (Blocker 2).** Thread-gate resolves the dispatch target; `resolve-provider.ts` routes desktop construction to the pull transport; cloud stays in-cluster. e2e specs poll `/links/work` + a fake harness posts to ingest; a new spec exercises `/links/proxy`. Green across e2e + multi-pod.
6. **Flip daemon default to pull** (hard break: users re-run `bunx decocms@latest link`). Green.
7. **Delete the reverse-WS** (existing Phase F task list: ws-gateway, dispatcher, dispatch-frames, cluster-connection, reconnect-backoff, buildDesktopProvider + resolve-provider call sites). Keep `payload-chunking` + `link-claim-registry`.

## 6. Risks (top)

1. **SSE over a pull reply-leg never ends** — the reply POST must be a streaming upload (`duplex:'half'`, as `handle-local-dispatch.ts` already does) consumed without buffering, or `EventSource.onopen` hangs forever.
2. **Abort/cancel per reqId** — browser tab close must free the daemon SSE slot (`MAX_SSE_CLIENTS=100`); reuse a control cancel frame keyed by reqId or leak slots on reconnect storms.
3. **Latency** — long-poll dequeue adds latency vs WS publish; hot vm-tools (read/glob/bash) are measurably slower. Mitigate with immediate-enqueue + held-open reply-leg + short long-poll window.
4. **`probeHealth` repoint** must be in the same stage as the transport swap, else cache probes hard-fail → cold-spawn thrash.
5. **Target-gated cutover** is mandatory (Blocker 1 regression already observed in `40562b383`).
6. **Multi-org pull** — the proxy loop inherits the work-poller single-org limitation; C-bis widens its blast radius (preview/events now depend on it).

## 7. THE go/no-go decision (§ openDecisionsForUser)

**The headline "delete the WS" is not self-justifying.** The chat hot path is ALREADY off the WS (A–E); the residual WS carries only sandbox control/events/vm-tools (lower frequency). Options:
- **(A) Do C-bis (stages 1–7) then delete the WS.** Worth it IF the WS reconnect/token-pinning bug (the documented cause of user-desktop chat **timeouts** — see memory `project_link_ws_expected_101_handshake_reject`) is actually hurting users, OR removing the two-pod NATS middle-man is itself the goal.
- **(C) Stop here.** Chat + cancel are pull; preview is local; leave the residual sandbox-control WS in place. Dramatically cheaper/lower-risk.

**Recommendation: confirm the motivation before committing to C-bis's full cost.** The original driver was the chat-path WS fragility — which is already fixed by A–E being live. If sandbox-control over WS is tolerable, (C) is the rational stop.
