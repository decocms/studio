# Sandbox preview simplification + reactivate-on-relink

**Date:** 2026-06-03
**Branch:** `tlgimenes/sandbox-reactivate-on-relink`
**Status:** Approved design, pending implementation plan

## Problem

A developer running `bunx decocms link` against the hosted Studio spawns a local
sandbox that shows up under their PROJECT. Three related failures break the
experience:

1. **Relink does not reactivate the sandbox.** After `Ctrl+C` on the link and a
   fresh `bunx decocms link`, sending a chat message does not respawn the
   sandbox on the new local daemon. Work never resumes.
2. **Terminal + preview latch into a dead state.** Once the link drops, neither
   the terminal UI nor the preview returns to a valid state, even after relink.
3. **Dev-command failure produces a sticky error UI.** When the dev script fails
   the frontend renders a dedicated `dev-script-failed` ("dev:x") error card.
   Restarting the dev command does not clear it — the card stays stuck.

### Root causes (verified in code)

The NATS/claim transport itself handles relink correctly — dispatch routes by
`userSub` (`apps/mesh/src/links/dispatcher.ts:134`) and the gateway re-puts the
claim under the same key on relink (`apps/mesh/src/links/ws-gateway.ts:onHello`).
The failures come from state machines that latch and never reset:

- **Backend never re-provisions (root cause #1).**
  `apps/mesh/src/tools/sandbox/start.ts:188-202` — `ensureSandbox` has a
  fast-path that returns the cached `sandboxMap` entry **without calling
  `runner.ensure()`**. The correct probe→404→respawn logic in
  `packages/sandbox/server/provider/desktop/runner.ts:83` (`ensure`) is bypassed.
  The `sandboxMap` entry lives in `virtualMcp.metadata` (cluster Postgres) and
  survives the link disconnect, so `existing` is always truthy. The only code
  that could reap it — `invalidateHandle` in
  `apps/mesh/src/harnesses/decopilot/built-in-tools/index.ts:214` — is gated
  `if (!canAutoRestart) return` where `canAutoRestart = branch === "ephemeral"`
  (line 213), so for any GitHub-linked PROJECT it is a no-op. The stale handle is
  never cleared and chat tool calls keep proxying to a dead handle (daemon
  answers `404 "unknown handle"`).

- **Frontend SSE latches `terminalFailure` (root cause #2).**
  While the link is down, the cluster SSE handler
  `apps/mesh/src/api/routes/sandbox-events-handler.ts:255-270` exhausts its 60s
  proxy-open retry budget and emits `event: phase {kind:"failed"}`. The UI
  (`apps/mesh/src/web/components/sandbox/hooks/sandbox-events-context.tsx:233-236`)
  sets `terminalFailure = true` and closes the EventSource. All three reconnect
  paths early-return on `terminalFailure` (`connect`:346, `onerror`:361,
  `scheduleReconnect`:376), and the effect only re-subscribes when
  `[virtualMcpId, branch, org.slug, enabled]` change — none of which change on
  relink. The stream stays permanently dead, so the preview's self-heal
  (`gone → SANDBOX_START`) can never fire either.

- **Sticky dev-fail card.** The daemon flips `lifecycle.phase` to
  `start-failed`; `preview.tsx:317-322` maps that to a latched `lifecycleFailure`
  that drives the `dev-script-failed` state and does not clear on dev restart.

Chat keeps working throughout because the chat thread stream
(`thread-connection.ts`) is a separate, self-reconnecting SSE.

## Goals

- Relink + a chat message (or self-heal) reactivates the sandbox and resumes work.
- Terminal and preview recover automatically once the link is back — no manual
  page reload.
- A dev-command failure (and its recovery) requires no sticky frontend state.
- Drastically simplify the frontend preview state machine: state lives on the
  daemon, close to the process, and is easier to maintain.

## Non-goals

- Routing the iframe through the cluster proxy. We keep the iframe pointing
  directly at the local ingress (`http://<handle>.localhost:<ingressPort>`) so
  the dev server and HMR websockets stay local. When the link is down the iframe
  shows the **raw browser connection-refused page** — this is acceptable and
  preferred over maintaining a "link offline" frontend state.
- Changing the NATS link transport, claim registry, or dispatch routing.
- Persisting the daemon's in-memory sandbox map across restarts (killing
  sandboxes on `Ctrl+C` is correct; the resulting 404 is the intended respawn
  trigger that root cause #1 currently ignores).

## Design

### A. Frontend — collapse the state machine

Files: `apps/mesh/src/web/components/sandbox/preview/preview.tsx`,
`apps/mesh/src/web/components/sandbox/preview/preview-state.ts`.

Delete `computePreviewState`'s 8 kinds and the latches that feed them:
`htmlSupportRef`, `lifecycleFailure`/`dev-script-failed`, `crashed`, `no-html`,
`errored`, and the SSE-silence `suspended`. The component reduces to two render
outcomes:

- **`previewUrl` exists → always render the `<iframe>`**, `src = previewUrl`,
  unconditionally. Whatever the iframe shows (live dev server, daemon fallback
  page, or browser connection-refused) is the displayed state. No overlays.
- **No `previewUrl` yet** (never provisioned) → a thin "starting…" placeholder
  while auto-start runs. This is the only remaining non-iframe state.

Keep the surrounding chrome: toolbar (reload / restart-dev), terminal drawer,
script tabs. Keep the explicit user **pause** affordance as-is (only the
failure/connection states are removed).

### B. SSE — eternally retrying, never terminal

Files: `apps/mesh/src/web/components/sandbox/hooks/sandbox-events-context.tsx`,
`apps/mesh/src/api/routes/sandbox-events-handler.ts`.

- Remove the `terminalFailure` latch and the `phase:failed → es.close()` path.
  The EventSource always reconnects with backoff, indefinitely.
- Server side: stop emitting a terminal `phase:failed` when the daemon is merely
  unreachable; let the client keep retrying (it will receive logs / `gone` once
  the link returns).
- The SSE's remaining frontend jobs: terminal logs, script tabs, and firing
  self-heal on `gone`.

### C. Daemon + ingress — render every "not live" case as served HTML

Files: `apps/mesh/src/link-daemon/local-ingress.ts`,
`packages/sandbox/daemon/proxy.ts`.

- **Ingress:** replace the `404 "unknown handle"` (`local-ingress.ts:52-53`)
  with an auto-reloading "connecting to sandbox…" HTML page (same shape as the
  daemon proxy's `NO_UPSTREAM_HTML`). A not-yet-respawned handle then shows a
  friendly reloading page inside the iframe instead of a bare 404.
- **Daemon proxy:** keep/extend `NO_UPSTREAM_HTML` so "no dev server / dev
  crashed / dev failed" all render the same auto-reloading page, optionally
  surfacing the last dev-script exit reason. This is where the sticky "dev:x
  failed" UI moves to; because the page auto-reloads, restarting `dev` recovers
  with zero frontend state.
- Mirror the same "connecting" behavior in the cluster sandbox proxy
  (`apps/mesh/src/api/routes/sandbox-proxy.ts`) for parity, so cloud sandboxes
  behave identically.

### D. Backend — make relink actually respawn

Files: `apps/mesh/src/tools/sandbox/start.ts`,
`apps/mesh/src/harnesses/decopilot/built-in-tools/index.ts`.

- In `ensureSandbox`, when the fast-path finds an existing `user-desktop` entry,
  **re-validate it** (`runner.alive(handle)` / probe) before returning. On a dead
  probe, reap the `sandboxMap` entry + state-store row and re-provision via
  `runner.ensure()`. This reuses the already-correct probe→404→respawn path in
  the desktop provider.
- Allow the self-heal / `invalidateHandle` reap to run for non-ephemeral desktop
  branches too (today gated to `ephemeral`).

## Data flow

**Ctrl+C → relink → send message.**
Link down → iframe shows the browser connection-refused page (accepted). Relink →
ingress back; iframe auto-reloads and the ingress serves "connecting…". Next chat
message (or self-heal on SSE `gone`) → `ensureSandbox` re-probes → 404 →
re-provisions on the new daemon via `runner.ensure()` → the iframe's next reload
hits the live dev server. The SSE reconnected throughout (no latch).

**Dev command fails → restart.**
Dev port drops → daemon proxy serves the auto-reloading "no dev server" page
inside the iframe (no frontend `dev-script-failed`). User restarts dev → port
returns → auto-reload shows the app. Nothing sticky.

## Testing

- **Unit**
  - Ingress: unknown handle returns the reloading HTML page (not 404).
  - `ensureSandbox`: a dead existing `user-desktop` entry is re-probed, reaped,
    and re-provisioned (fast-path no longer returns a dead handle).
  - SSE context: keeps reconnecting after a `failed`/error (no `terminalFailure`
    latch).
  - `preview-state`: reduced state model renders the iframe whenever `previewUrl`
    exists.
- **E2E (Playwright)**
  - Relink recovery: link → Ctrl+C → relink → message → preview + terminal resume.
  - Dev-restart recovery: dev fail → restart → preview shows the app, no sticky
    card.

## Decisions / defaults

1. Keep a thin "starting…" placeholder for the first-ever provision (no
   `previewUrl` yet) rather than making the URL deterministic so the iframe is
   literally always mounted. Smaller change.
2. Keep the explicit user **pause** affordance; only failure/connection states
   are deleted.
3. Apply the ingress fallback to desktop and mirror "connecting" behavior in the
   cluster proxy for parity.

## Affected files (summary)

- `apps/mesh/src/web/components/sandbox/preview/preview.tsx`
- `apps/mesh/src/web/components/sandbox/preview/preview-state.ts` (+ test)
- `apps/mesh/src/web/components/sandbox/hooks/sandbox-events-context.tsx`
- `apps/mesh/src/api/routes/sandbox-events-handler.ts`
- `apps/mesh/src/link-daemon/local-ingress.ts`
- `packages/sandbox/daemon/proxy.ts`
- `apps/mesh/src/api/routes/sandbox-proxy.ts`
- `apps/mesh/src/tools/sandbox/start.ts`
- `apps/mesh/src/harnesses/decopilot/built-in-tools/index.ts`
