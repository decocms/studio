# CLI Login Success Page Design

**Status:** Approved
**Date:** 2026-05-26

## Problem

When a user runs `bunx decocms auth login`, the CLI opens the studio
`/login` page (a polished split layout with imagery and the unified auth
form) in the browser. After the user authenticates, the OAuth flow
redirects back to a localhost callback server inside the CLI, which
currently responds with a hardcoded inline HTML page:

```
"You're logged in." (#0f0 neon green) on #0b0b0b background
"You can return to your terminal."
```

This page is visually jarring next to the polished `/login` page the user
just came from. It also gives no feedback about *which* account was
actually logged in.

## Goal

Replace the inline HTML page with a polished, personalized success page
that lives inside the studio web app and shares the same design language
as `/login`, so the transition from "logging in" to "logged in" is
seamless.

## Non-Goals

- Adding CTAs ("Open dashboard", "Close tab", etc.) — the page should
  reinforce a single message: return to your terminal.
- Designing for offline / unreachable-`target` fallback — the same
  `target` served the login UI seconds earlier in the same flow.
- Adding a visible countdown or close affordance.

## Approach

1. **Localhost callback returns a 302 redirect.** The CLI's
   `startOAuthCallbackServer` (`apps/mesh/src/cli/lib/oauth-callback.ts`)
   currently returns inline HTML. Change it to return HTTP 302 with
   `Location: ${target}/cli/auth-success`. The auth code is still
   captured server-side from the URL params, so the CLI's
   `waitForCallback()` resolves normally — no protocol change.

   `startOAuthCallbackServer` needs to know the redirect target, so a
   new `successRedirectUrl: string` option is added to `StartOptions`.
   `loginCommand` already knows the target (the same `target` it sent
   the user to for `/login`) and passes it in.

2. **New hosted route `/cli/auth-success`.** A new file
   `apps/mesh/src/web/routes/cli-auth-success.tsx` rendering a component
   wrapped in `AuthSplitLayout` (same component used by `/login`). It:

   - Reads the active session via `authClient.useSession()`. The session
     cookie is fresh because the user authenticated against the same
     origin seconds ago.
   - Displays:
     > **You're logged in as `<email>`.**
     > You can return to your terminal.
   - If no email is available in the session (`session.data?.user?.email`
     falsy), or no session at all, falls back to the non-personalized
     copy:
     > **You're logged in.**
     > You can return to your terminal.
   - Silently calls `window.close()` once when the component mounts. No
     countdown, no visible affordance. Works in the rare cases where the
     browser allows it; invisible otherwise.

3. **Route registration.** A new `cliAuthSuccessRoute` is added in
   `apps/mesh/src/web/index.tsx` next to the existing `loginRoute`, with
   path `/cli/auth-success` and no search-param schema. Registered as a
   child of `rootRoute` (not behind the auth shell).

## What Stays the Same

- State validation, PKCE, token exchange, session writing — all unchanged.
- "State mismatch" and "Missing code" error responses stay as inline
  plain-text responses; they are terminal-only failure paths not worth a
  hosted page.
- The CLI's `target` flag still controls everything — self-hosted
  deployments work automatically because the redirect goes to
  `${target}/cli/auth-success`.

## Files Touched

- `apps/mesh/src/cli/lib/oauth-callback.ts` — accept
  `successRedirectUrl` in `StartOptions`; return 302 instead of inline
  HTML when state + code are valid.
- `apps/mesh/src/cli/lib/oauth-callback.test.ts` — update tests to
  assert 302 + correct `Location` header.
- `apps/mesh/src/cli/commands/auth/login.ts` — pass
  `successRedirectUrl: ${target}/cli/auth-success` into
  `startOAuthCallbackServer`.
- `apps/mesh/src/web/routes/cli-auth-success.tsx` — new route component.
- `apps/mesh/src/web/index.tsx` — register the new route.

## Out of Scope

- Removing the inline HTML success page entirely from the codebase (it
  goes away as part of this change; no compatibility shim is needed).
- Authenticated-shell access to the page. The route is public — no
  redirect to `/login` if the session is missing.
