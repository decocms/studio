# `decocms link` Auto-Login UX

**Status:** Design
**Date:** 2026-05-28
**Owner:** tlgimenes

## Problem

Today, `bunx decocms link` requires the user to have already run `decocms auth login`. If no session exists, the link command exits with:

> `No session found. Run \`deco auth login\` first, then re-run \`deco link\`.`

This is friction for first-time users: they hit an error, run a second command, then re-run the first. Other CLIs in this space (`gh`, `vercel`, `wrangler`) detect the missing session, run their login flow inline, then continue. We want the same.

Separately, sessions that expired silently pass the existing `readSession` check and fail later at the WebSocket handshake with an opaque 401. We can fix both gaps with the same helper.

## Goals

1. `decocms link` with no session on an interactive terminal: auto-runs login, then continues, no second command needed.
2. `decocms link` with an expired session: silently refreshes when possible; auto-runs login when refresh fails for credential reasons.
3. CI / non-interactive environments keep the existing hard-error behavior — no surprise browser launches.
4. Factor the logic so other commands can adopt the same UX later without duplication.

## Non-goals

- Wiring `ensureSession` into `whoami`, `logout`, or any other command. Helper is built generically; only `link` adopts it in this iteration.
- Changing the OAuth/PKCE flow, the session file format, or the token endpoint.
- Adding rich Ink-rendered status UI for the login sequence. Plain `console.log` output, matching current style.
- Auto-retrying the link WebSocket if it 401s *after* a successful login (could mask revoked access).

## Architecture

A new helper, `ensureSession`, sits between commands and the session file. Commands that need a valid session call it; it returns one or throws.

```
┌──────────────┐    ┌──────────────────┐    ┌──────────────────┐
│ link command │───▶│  ensureSession   │───▶│  Session object  │
└──────────────┘    │                  │    └──────────────────┘
                    │  - readSession   │
                    │  - refresh?      │
                    │  - login?        │
                    │  - TTY check     │
                    └──────────────────┘
                          │   │
                          ▼   ▼
                  refreshSession   performInteractiveLogin
                  (POST token)     (OAuth + PKCE — extracted
                                    from existing login command)
```

`startLinkDaemon` stops reading the session itself; it accepts a `Session` from the caller. This keeps the daemon strictly downstream of auth and easier to test.

### `ensureSession` decision tree

```
read session
├── absent ─────────────────────────────────┐
│                                           ▼
├── present, fresh ──▶ return                 (login branch)
│                                           ▼
└── present, expired                  isInteractive?
    ├── has refreshToken?              ├── no  ─▶ throw "No session..."
    │   ├── refresh OK ─▶ rewrite,     └── yes ─▶ performInteractiveLogin
    │   │                  return                 ─▶ write session, return
    │   ├── invalid_grant ─▶ login branch
    │   └── transient err ─▶ throw "Could not refresh: …"
    └── no refreshToken ─▶ login branch
```

Clock skew: a session is treated as expired when `expiresAt - 60 < now()`.

## Components

### New files

- `apps/mesh/src/cli/lib/ensure-session.ts` — the helper. Pure logic, all I/O injectable (`fetch`, `openBrowser`, `now`, `readSession`, `writeSession`).
- `apps/mesh/src/cli/lib/refresh-session.ts` — `refreshSession(session, fetchImpl)`. POSTs `grant_type=refresh_token` to `<target>/api/auth/mcp/token` with the session's `clientId`. Returns updated `Session` or throws `RefreshFailedError { kind: "invalid_grant" | "transient" }`. Mirrors the shape of `exchangeToken` in `login.ts`.
- `apps/mesh/src/cli/lib/ensure-session.test.ts` — unit tests over the decision matrix.
- `apps/mesh/src/cli/lib/refresh-session.test.ts` — unit tests for the refresh call.

### Refactored files

- `apps/mesh/src/cli/commands/auth/login.ts` — extract the OAuth dance (register → open browser → wait for callback → exchange) into an exported `performInteractiveLogin(opts): Promise<Session>`. The existing `loginCommand` becomes a thin wrapper: calls `performInteractiveLogin`, writes the session, prints the success message, returns exit code. `ensureSession` reuses `performInteractiveLogin` (writing the session itself).
- `apps/mesh/src/link-daemon/index.ts` — `startLinkDaemon` accepts a required `session: Session` field on its options. Removes the internal `readSession` call and the "No session found" throw. Imports `Session` from `cli/lib/session.ts`.
- `apps/mesh/src/link-daemon/session.ts` — **deleted**. It duplicates `cli/lib/session.ts` (same `Session` type, same `readSession`, same `isSession` validator). All consumers move to the canonical version.
- `apps/mesh/src/cli/commands/link.ts` — calls `ensureSession({ dataDir, intent: "Link" })` then passes the session into `startLinkDaemon`.

### Untouched

`whoami`, `logout`, session storage shape (`apps/mesh/src/cli/lib/session.ts`), OAuth callback server, PKCE helper.

## API

```ts
// ensure-session.ts
export interface EnsureSessionOptions {
  dataDir: string;
  /** Human-readable intent, used in the "signing in to <intent>" message. */
  intent: string;
  /** Defaults to session.target if a session exists, else DEFAULT_TARGET. */
  target?: string;
  /** Defaults to process.stdout.isTTY. */
  isInteractive?: boolean;
  // Injectables (all default to real implementations):
  openBrowser?: (url: string) => Promise<void>;
  fetch?: typeof fetch;
  now?: () => number; // ms since epoch
}

export async function ensureSession(opts: EnsureSessionOptions): Promise<Session>;
```

```ts
// refresh-session.ts
export class RefreshFailedError extends Error {
  kind: "invalid_grant" | "transient";
}

export async function refreshSession(
  session: Session,
  fetchImpl?: typeof fetch,
  now?: () => number,
): Promise<Session>;
```

```ts
// auth/login.ts (new export)
export interface PerformInteractiveLoginOptions {
  target?: string;
  openBrowser?: (url: string) => Promise<void>;
  fetch?: typeof fetch;
}
export async function performInteractiveLogin(
  opts: PerformInteractiveLoginOptions,
): Promise<Session>;
```

## Behavior

### Happy paths

| Scenario | UX |
| --- | --- |
| No session, TTY | Prints `Not logged in — opening browser to sign in to Link.` → runs login → prints `Logged in as <email>.` → continues to existing link startup output. |
| Valid session | Silent. Link proceeds exactly as today. |
| Expired session, refresh works | Silent. Session file rewritten with new `accessToken`, `expiresAt`, and (if rotated) `refreshToken`. Link proceeds. |
| Expired session, refresh fails with `invalid_grant`, TTY | Prints `Session expired — opening browser to sign in again.` → runs login → continues. |

### Error paths

| Scenario | UX |
| --- | --- |
| No session, non-TTY | Throws existing message: `No session found. Run \`deco auth login\` first, then re-run \`deco link\`.` Exit 1. |
| Expired session, refresh fails with transient error (network / 5xx), any TTY state | Throws `Could not refresh session: <reason>. Run \`deco auth login\` to sign in again.` Exit 1. Does NOT auto-fall-back to a browser login — a fresh login attempt will likely fail the same way, and the user benefits from the diagnostic. |
| User cancels browser login (Ctrl+C) | Existing `loginCommand` cleanup runs (OAuth callback server closes). Link command exits 1. |
| Login succeeds but link WebSocket still 401s | Surface the WebSocket error. No auto-retry — likely a revoked access situation; retrying would loop. |

### Backwards compatibility

`bunx decocms link` on a TTY with a valid session behaves identically to today. The behavior change is strictly on the no-session and expired-session branches.

## Testing

### Unit (`bun test`)

- `refresh-session.test.ts`
  - 200 success rewrites session with new tokens and `expiresAt`.
  - 400 `invalid_grant` → throws `RefreshFailedError { kind: "invalid_grant" }`.
  - 5xx → throws `RefreshFailedError { kind: "transient" }`.
  - Network error (fetch rejects) → throws `RefreshFailedError { kind: "transient" }`.
- `ensure-session.test.ts` — matrix:
  - no session + TTY → calls `performInteractiveLogin`, returns its session.
  - no session + non-TTY → throws "No session found…".
  - valid session → returns it, no network calls.
  - expired session + refresh OK → returns refreshed session, session file rewritten.
  - expired session + refresh `invalid_grant` + TTY → calls `performInteractiveLogin`.
  - expired session + refresh `invalid_grant` + non-TTY → throws.
  - expired session + refresh transient → throws (regardless of TTY).
  - clock skew: `expiresAt = now + 30s` is treated as expired.

### E2E

- Existing link happy-path test: continues to work; session pre-seeded.
- New case: session file absent, `performInteractiveLogin` stubbed to return a synthetic session, verify the wiring through `link → ensureSession → startLinkDaemon`. No real browser.

## Open questions

None at design time. The remaining decisions are mechanical (file naming, exact log strings) and can be made during implementation.

## Future work (out of scope)

- Wire `ensureSession` into `whoami` (currently exits 1 on missing session — could optionally auto-login behind a flag, or stay strict).
- Proactive refresh: background-refresh sessions before expiry while link is running, so long-lived link sessions don't 401 mid-daemon.
- Rich Ink-rendered status UI if/when more commands need richer feedback.
