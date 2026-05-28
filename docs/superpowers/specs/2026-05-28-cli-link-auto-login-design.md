# `decocms link` Auto-Login UX

**Status:** Design
**Date:** 2026-05-28
**Owner:** tlgimenes

## Problem

Today, `bunx decocms link` requires the user to have already run `decocms auth login`. If no session exists, the link command exits with:

> `No session found. Run \`deco auth login\` first, then re-run \`deco link\`.`

This is friction for first-time users: they hit an error, run a second command, then re-run the first. Other CLIs in this space (`gh`, `vercel`, `wrangler`) detect the missing session, run their login flow inline, then continue. We want the same.

Separately, sessions that expired silently pass the existing `readSession` check and fail later at the WebSocket handshake with an opaque 401. The same plumbing fixes both gaps, and lets `whoami` quietly renew expired tokens too instead of telling the user to re-login.

## Goals

1. `decocms link` with no session on an interactive terminal: auto-runs login, then continues, no second command needed.
2. `decocms link` with an expired session: silently refreshes when possible; auto-runs login when refresh fails for credential reasons.
3. `decocms auth whoami` with an expired session: silently refreshes when possible. No surprise browser launches — `whoami` is a diagnostic, not a mutator.
4. CI / non-interactive environments keep the existing hard-error behavior — no surprise browser launches.
5. Factor the logic so future session-aware commands adopt the same UX without duplication.

## Non-goals

- Wiring `ensureSession` (auto-login) into `whoami`. `whoami` is read-only; it uses the `getValidSession` layer (refresh-only, no browser).
- Touching `logout`. Refreshing or auto-logging-in before tearing down is nonsensical.
- Touching `dev`. It uses a synthetic dev session minted by the cluster (`bootstrapDevLinkSession`), not real OAuth.
- Changing the OAuth/PKCE flow, the session file format, or the token endpoint.
- Adding rich Ink-rendered status UI for the login sequence. Plain `console.log` output, matching current style.
- Auto-retrying the link WebSocket if it 401s *after* a successful login (could mask revoked access).

## Architecture

Two layered helpers between commands and the session file:

- **`getValidSession`** — refresh-only. Reads the session, silently refreshes if expired. Returns `Session | null`. Never opens a browser. Used by anything that wants a valid session *if one exists* without coercing the user into a new one.
- **`ensureSession`** — auto-login on top of `getValidSession`. When `getValidSession` returns null on a TTY, falls back to interactive login. Returns `Session` or throws.

```
┌──────────────┐   ┌──────────────────┐
│ link command │──▶│  ensureSession   │
└──────────────┘   │  (login fallback)│
                   └────────┬─────────┘
                            │ calls
                            ▼
┌──────────────┐   ┌──────────────────┐    ┌──────────────────┐
│   whoami     │──▶│  getValidSession │───▶│ refreshSession   │
└──────────────┘   │   (refresh-only) │    │ (POST token)     │
                   └────────┬─────────┘    └──────────────────┘
                            │
                            ▼
                   ┌──────────────────┐
                   │   Session | null │
                   └──────────────────┘

ensureSession fallback (TTY only):
                  performInteractiveLogin
                  (OAuth + PKCE — extracted from existing login command)
```

`startLinkDaemon` stops reading the session itself; it accepts a `Session` from the caller. This keeps the daemon strictly downstream of auth and easier to test.

### `getValidSession` decision tree

```
read session
├── absent ─▶ return null
├── present, fresh ─▶ return session
└── present, expired
    ├── no refreshToken ─▶ return null
    ├── refresh OK ─▶ writeSession(refreshed) ─▶ return refreshed
    ├── refresh invalid_grant ─▶ return null
    └── refresh transient err ─▶ throw RefreshFailedError(transient)
```

Clock skew: treat as expired when `expiresAt - 60 < now()`.

Note: transient errors throw rather than returning null, because they don't mean "you need to log in" — they mean "we couldn't tell yet." Callers can choose how to surface this.

### `ensureSession` decision tree

```
getValidSession()
├── returns Session ─▶ return it
├── throws transient ─▶ rethrow (don't open a browser on a network blip)
└── returns null
    ├── isInteractive (TTY) ─▶ performInteractiveLogin → writeSession → return
    └── non-interactive ─▶ throw "No session found. Run `deco auth login` first..."
```

## Components

### New files

- `apps/mesh/src/cli/lib/refresh-session.ts` — `refreshSession(session, fetchImpl?, now?)`. POSTs `grant_type=refresh_token` to `<target>/api/auth/mcp/token` with the session's `clientId`. Returns updated `Session` or throws `RefreshFailedError { kind: "invalid_grant" | "transient" }`. Mirrors the shape of `exchangeToken` in `login.ts`.
- `apps/mesh/src/cli/lib/get-valid-session.ts` — `getValidSession(opts)`. The refresh-only layer. Reads, validates expiry, refreshes when possible, rewrites the session file on successful refresh.
- `apps/mesh/src/cli/lib/ensure-session.ts` — `ensureSession(opts)`. The auto-login layer on top of `getValidSession`.
- `apps/mesh/src/cli/lib/refresh-session.test.ts` — unit tests for the refresh call.
- `apps/mesh/src/cli/lib/get-valid-session.test.ts` — unit tests over its decision matrix.
- `apps/mesh/src/cli/lib/ensure-session.test.ts` — unit tests for the login-fallback branches (the refresh branches are already covered by `get-valid-session.test.ts`; this suite mocks `getValidSession` directly).

### Refactored files

- `apps/mesh/src/cli/commands/auth/login.ts` — extract the OAuth dance (register → open browser → wait for callback → exchange) into an exported `performInteractiveLogin(opts): Promise<Session>`. The existing `loginCommand` becomes a thin wrapper: calls `performInteractiveLogin`, writes the session, prints the success message, returns exit code. `ensureSession` reuses `performInteractiveLogin`.
- `apps/mesh/src/cli/commands/auth/whoami.ts` — call `getValidSession` instead of `readSession`. Behavior change: an expired-but-refreshable session now reports successfully (and writes back the refreshed session) instead of telling the user to re-login.
- `apps/mesh/src/link-daemon/index.ts` — `startLinkDaemon` accepts a required `session: Session` field on its options. Removes the internal `readSession` call and the "No session found" throw. Imports `Session` from `cli/lib/session.ts`.
- `apps/mesh/src/link-daemon/session.ts` — **deleted**. It duplicates `cli/lib/session.ts` (same `Session` type, same `readSession`, same `isSession` validator). All consumers move to the canonical version.
- `apps/mesh/src/cli/commands/link.ts` — calls `ensureSession({ dataDir, intent: "Link" })` then passes the session into `startLinkDaemon`.

### Untouched

`logout`, `dev`, session storage shape (`apps/mesh/src/cli/lib/session.ts`), OAuth callback server, PKCE helper.

## API

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
// get-valid-session.ts
export interface GetValidSessionOptions {
  dataDir: string;
  fetch?: typeof fetch;
  now?: () => number;
}

/**
 * Returns a known-valid session, refreshing it if expired.
 * Returns null when no session exists or the refresh token is no longer accepted.
 * Throws RefreshFailedError(transient) on network/server errors during refresh.
 * Never opens a browser.
 */
export async function getValidSession(
  opts: GetValidSessionOptions,
): Promise<Session | null>;
```

```ts
// ensure-session.ts
export interface EnsureSessionOptions {
  dataDir: string;
  /** Human-readable intent, used in the "signing in to <intent>" message. */
  intent: string;
  /** Defaults to process.stdout.isTTY. */
  isInteractive?: boolean;
  // Injectables (all default to real implementations):
  openBrowser?: (url: string) => Promise<void>;
  fetch?: typeof fetch;
  now?: () => number;
}

export async function ensureSession(
  opts: EnsureSessionOptions,
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

### `decocms link`

| Scenario | UX |
| --- | --- |
| Valid session | Silent. Link proceeds exactly as today. |
| Expired session, refresh works | Silent. Session file rewritten. Link proceeds. |
| No session, or expired session with refresh failed (`invalid_grant`), TTY | Prints `Not logged in — opening browser to sign in to Link.` → runs login → prints `Logged in as <email>.` → continues. |
| No session, non-TTY | Throws existing message: `No session found. Run \`deco auth login\` first, then re-run \`deco link\`.` Exit 1. |
| Expired session, refresh fails with transient error (network / 5xx), any TTY state | Throws `Could not refresh session: <reason>. Run \`deco auth login\` to sign in again.` Exit 1. Does NOT auto-fall-back to a browser login — a fresh login attempt will likely fail the same way, and the user benefits from the diagnostic. |
| User cancels browser login (Ctrl+C) | Existing `loginCommand` cleanup runs. Link command exits 1. |
| Login succeeds but link WebSocket still 401s | Surface the WebSocket error. No auto-retry. |

### `decocms auth whoami`

| Scenario | UX |
| --- | --- |
| Valid session | Prints target + user, exit 0 (same as today). |
| Expired session, refresh works | **New:** silently refreshes, rewrites session, then prints target + user, exit 0. |
| Expired session, refresh fails with `invalid_grant` | Prints existing `Not logged in. Run \`decocms auth login\` to authenticate.` Exit 1. |
| Expired session, refresh fails with transient error | Prints `Could not refresh session: <reason>. Run \`decocms auth login\` to authenticate.` Exit 1. |
| No session | Prints existing `Not logged in. Run \`decocms auth login\` to authenticate.` Exit 1. |

### Backwards compatibility

- `link` on a TTY with a valid session: identical to today.
- `whoami` with a valid session: identical to today.
- `whoami` with a missing session: identical to today.
- `whoami` with an expired session: **changes** — previously printed the cached identity from the expired session (it didn't check `expiresAt`); now silently refreshes when possible, or reports "not logged in" when refresh fails. This is the correct behavior and the old behavior was a latent bug.
- `logout` and `dev`: unchanged.

## Testing

### Unit (`bun test`)

- `refresh-session.test.ts`
  - 200 success returns updated session with new tokens and `expiresAt`.
  - 400 `invalid_grant` → throws `RefreshFailedError { kind: "invalid_grant" }`.
  - 5xx → throws `RefreshFailedError { kind: "transient" }`.
  - Network error (fetch rejects) → throws `RefreshFailedError { kind: "transient" }`.
- `get-valid-session.test.ts` — decision matrix:
  - no session → null.
  - fresh session → returns it, no network calls.
  - expired session, no refresh token → null.
  - expired session, refresh OK → returns refreshed, session file rewritten.
  - expired session, refresh invalid_grant → null.
  - expired session, refresh transient → throws (does not return null).
  - clock skew: `expiresAt = now + 30s` is treated as expired.
- `ensure-session.test.ts` — login-fallback layer (mocks `getValidSession`):
  - `getValidSession` returns Session → returns it, no login called.
  - `getValidSession` returns null + TTY → calls `performInteractiveLogin`, writes session, returns it.
  - `getValidSession` returns null + non-TTY → throws "No session found…".
  - `getValidSession` throws transient → rethrows.

### E2E

- Existing `link` happy-path test: continues to work; session pre-seeded.
- New `link` case: session file absent, `performInteractiveLogin` stubbed to return a synthetic session, verify the wiring through `link → ensureSession → startLinkDaemon`. No real browser.
- New `whoami` case: write an expired session with a refresh token; stub the token endpoint to return a fresh token; assert `whoami` exits 0, prints identity, and the session file on disk is updated.

## Open questions

None at design time. Remaining decisions are mechanical (file naming, exact log strings) and can be made during implementation.

## Future work (out of scope)

- Proactive refresh while link is running: background-renew sessions before they expire so long-lived link sessions never see a 401 mid-daemon.
- Rich Ink-rendered status UI if/when more commands need richer feedback.
- Adopting `ensureSession` in any new command that needs an authenticated session — the helper is built generically for this.
