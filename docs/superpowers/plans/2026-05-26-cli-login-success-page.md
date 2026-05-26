# CLI Login Success Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the ugly hardcoded HTML page served by the CLI's localhost OAuth callback with a polished, personalized success page hosted inside the studio web app, sharing the same design language as `/login`.

**Architecture:** The CLI's localhost callback server captures the OAuth `code` from URL params (unchanged), then responds with a 302 redirect to a new `/cli/auth-success` route on the studio web app. That React route renders inside `AuthSplitLayout` (same layout used by `/login`), reads the fresh session via `authClient.useSession()` to display the user's email, and silently attempts `window.close()` on mount.

**Tech Stack:** Bun (CLI + test runner), Hono (server, indirect), TanStack Router (web routing), React 19, Better Auth (session), TypeScript, Biome (formatter).

**Spec:** `docs/superpowers/specs/2026-05-26-cli-login-success-page-design.md`

---

## Background a New Engineer Needs

- `apps/mesh/src/cli/lib/oauth-callback.ts` runs an in-process `Bun.serve` HTTP server on `127.0.0.1:<random-port>` to receive the OAuth redirect from the studio after the user signs in. It validates `state`, extracts `code`, resolves a promise the CLI is awaiting, and returns a response to the browser. Today that response is hardcoded HTML.
- `apps/mesh/src/cli/commands/auth/login.ts` orchestrates the flow: dynamic OAuth client registration → opens `${target}/login?...` in the browser → awaits the callback → exchanges the code for tokens → writes the session file. `target` defaults to `https://studio.decocms.com` and can be overridden via `--target`.
- The studio web app uses **TanStack Router** with imperative route definitions in `apps/mesh/src/web/index.tsx`. Routes are added to the tree via `rootRoute.addChildren([...])`. The existing `/login` route is a good template.
- `AuthSplitLayout` (`apps/mesh/src/web/components/auth-split-layout.tsx`) is a two-column layout: form/content on the left (max-w-[440px], `bg-sidebar`), full-height image on the right (`bg-muted`, defaults to `/onboarding-placeholder.png`).
- `authClient.useSession()` (from Better Auth) returns `{ data: { user: { email, name, ... }, session: ... } | null, isPending: boolean }`. It reads from the cookie set during the OAuth login flow.
- React 19 + this codebase **bans `useEffect`** (`plugins/ban-use-effect.ts`) and `useMemo`/`useCallback`/`memo` (`plugins/ban-memoization.ts`). The pattern for "do something once on mount" without `useEffect` here is the `// oxlint-disable-next-line ban-use-effect/ban-use-effect` escape hatch — see existing usage in `apps/mesh/src/web/routes/login.tsx:16` (the `AutoLogin` component does the same thing). We will use that escape hatch for the `window.close()` call.
- Tests live next to source files as `*.test.ts`. Run with `bun test path/to/file.test.ts`.
- **Always run `bun run fmt` before committing.** A lefthook pre-commit hook also runs it.

---

## File Structure

**Modify:**
- `apps/mesh/src/cli/lib/oauth-callback.ts` — accept `successRedirectUrl` option; return 302 instead of HTML.
- `apps/mesh/src/cli/lib/oauth-callback.test.ts` — update expectations to assert 302 + `Location` header.
- `apps/mesh/src/cli/commands/auth/login.ts` — pass `successRedirectUrl: \`${target}/cli/auth-success\`` into `startOAuthCallbackServer`.
- `apps/mesh/src/web/index.tsx` — register the new `cliAuthSuccessRoute`.

**Create:**
- `apps/mesh/src/web/routes/cli-auth-success.tsx` — new route component.

---

## Task 1: Add `successRedirectUrl` option to `startOAuthCallbackServer` (TDD)

**Files:**
- Modify: `apps/mesh/src/cli/lib/oauth-callback.ts`
- Test: `apps/mesh/src/cli/lib/oauth-callback.test.ts`

- [ ] **Step 1: Update the existing "resolves with code + state" test to expect a 302 redirect.**

Open `apps/mesh/src/cli/lib/oauth-callback.test.ts` and replace the first test case with the version below. The new test passes `successRedirectUrl` and asserts the response is a 302 with the correct `Location` header. We also assert no redirect-follow is needed by passing `redirect: "manual"`.

```typescript
import { describe, expect, it } from "bun:test";
import { startOAuthCallbackServer } from "./oauth-callback";

describe("startOAuthCallbackServer", () => {
  it("redirects to successRedirectUrl when the browser hits the callback URL", async () => {
    const server = await startOAuthCallbackServer({
      expectedState: "nonce-1",
      successRedirectUrl: "https://studio.example.com/cli/auth-success",
    });
    try {
      const responsePromise = fetch(`${server.url}/?code=abc&state=nonce-1`, {
        redirect: "manual",
      });
      const callback = await server.waitForCallback();
      expect(callback).toEqual({ code: "abc" });
      const response = await responsePromise;
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(
        "https://studio.example.com/cli/auth-success",
      );
    } finally {
      server.close();
    }
  });

  it("rejects waitForCallback when state does not match", async () => {
    const server = await startOAuthCallbackServer({
      expectedState: "nonce-1",
      successRedirectUrl: "https://studio.example.com/cli/auth-success",
    });
    try {
      await fetch(`${server.url}/?code=abc&state=wrong`);
      await expect(server.waitForCallback()).rejects.toThrow(/state mismatch/i);
    } finally {
      server.close();
    }
  });

  it("rejects waitForCallback when code is missing", async () => {
    const server = await startOAuthCallbackServer({
      expectedState: "nonce-1",
      successRedirectUrl: "https://studio.example.com/cli/auth-success",
    });
    try {
      await fetch(`${server.url}/?state=nonce-1`);
      await expect(server.waitForCallback()).rejects.toThrow(/missing code/i);
    } finally {
      server.close();
    }
  });

  it("returns 204 to follow-up requests after the promise has settled", async () => {
    const server = await startOAuthCallbackServer({
      expectedState: "nonce-1",
      successRedirectUrl: "https://studio.example.com/cli/auth-success",
    });
    try {
      await fetch(`${server.url}/?code=abc&state=nonce-1`, {
        redirect: "manual",
      });
      const callback = await server.waitForCallback();
      expect(callback).toEqual({ code: "abc" });

      const followUp = await fetch(`${server.url}/?code=other&state=nonce-1`);
      expect(followUp.status).toBe(204);
    } finally {
      server.close();
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail.**

Run: `bun test apps/mesh/src/cli/lib/oauth-callback.test.ts`

Expected: at minimum the first test fails (TypeScript will likely complain about the unknown `successRedirectUrl` option, OR the assertion on status 302 fails because the current implementation returns 200).

- [ ] **Step 3: Implement `successRedirectUrl` + 302 redirect in `oauth-callback.ts`.**

Replace the entire contents of `apps/mesh/src/cli/lib/oauth-callback.ts` with:

```typescript
export interface OAuthCallback {
  code: string;
}

export interface OAuthCallbackServer {
  url: string;
  waitForCallback: () => Promise<OAuthCallback>;
  /** Always call this after waitForCallback resolves or rejects (e.g., via try/finally). */
  close: () => void;
}

export interface StartOptions {
  expectedState: string;
  /**
   * Absolute URL the browser is redirected to after a successful callback.
   * The CLI typically points this at the studio's `/cli/auth-success`
   * route so the user lands on a polished, personalized success page
   * instead of inline localhost HTML.
   */
  successRedirectUrl: string;
  /** If provided, bind to this port. Defaults to 0 (OS-chosen). */
  port?: number;
}

export async function startOAuthCallbackServer(
  options: StartOptions,
): Promise<OAuthCallbackServer> {
  let resolveCallback!: (value: OAuthCallback) => void;
  let rejectCallback!: (err: Error) => void;
  const callbackPromise = new Promise<OAuthCallback>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });
  // Suppress unhandled-rejection warnings; callers consume via waitForCallback().
  callbackPromise.catch(() => {});

  let settled = false;
  const server = Bun.serve({
    port: options.port ?? 0,
    hostname: "127.0.0.1",
    fetch(req) {
      if (settled) {
        return new Response("", { status: 204 });
      }
      const url = new URL(req.url);
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (state !== options.expectedState) {
        settled = true;
        rejectCallback(new Error("OAuth state mismatch"));
        return new Response("State mismatch — close this tab.", {
          status: 400,
        });
      }
      if (!code) {
        settled = true;
        rejectCallback(new Error("OAuth callback missing code"));
        return new Response("Missing code — close this tab.", { status: 400 });
      }
      settled = true;
      resolveCallback({ code });
      return new Response(null, {
        status: 302,
        headers: { location: options.successRedirectUrl },
      });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    waitForCallback: () => callbackPromise,
    close: () => server.stop(true),
  };
}
```

Notes for the engineer:
- The previous `SUCCESS_PAGE` constant is removed entirely — no inline HTML success page anymore.
- `successRedirectUrl` is **required** (not optional) so every call site is forced to think about where to redirect.

- [ ] **Step 4: Run the tests to verify they pass.**

Run: `bun test apps/mesh/src/cli/lib/oauth-callback.test.ts`

Expected: all 4 tests pass.

- [ ] **Step 5: Format and commit.**

```bash
bun run fmt
git add apps/mesh/src/cli/lib/oauth-callback.ts apps/mesh/src/cli/lib/oauth-callback.test.ts
git commit -m "refactor(cli): redirect OAuth callback to hosted success URL"
```

---

## Task 2: Wire `loginCommand` to pass `successRedirectUrl`

**Files:**
- Modify: `apps/mesh/src/cli/commands/auth/login.ts`

- [ ] **Step 1: Update `loginCommand` to pass `successRedirectUrl`.**

In `apps/mesh/src/cli/commands/auth/login.ts`, find this line:

```typescript
const server = await startOAuthCallbackServer({ expectedState: state });
```

Replace it with:

```typescript
const server = await startOAuthCallbackServer({
  expectedState: state,
  successRedirectUrl: `${target}/cli/auth-success`,
});
```

`target` is already in scope (defined a few lines earlier as `const target = (options.target ?? DEFAULT_TARGET).replace(/\/$/, "");`), so no other changes are needed in this file.

- [ ] **Step 2: Type-check the CLI package.**

Run: `bun run check`

Expected: no new errors. (Pre-existing errors unrelated to this change can be ignored, but if the only error is in `login.ts` or `oauth-callback.ts`, it's something we introduced — fix before continuing.)

- [ ] **Step 3: Run the CLI tests once more to confirm nothing regressed.**

Run: `bun test apps/mesh/src/cli/`

Expected: all CLI tests pass.

- [ ] **Step 4: Format and commit.**

```bash
bun run fmt
git add apps/mesh/src/cli/commands/auth/login.ts
git commit -m "feat(cli): point OAuth callback to /cli/auth-success"
```

---

## Task 3: Create the `/cli/auth-success` route component

**Files:**
- Create: `apps/mesh/src/web/routes/cli-auth-success.tsx`

- [ ] **Step 1: Create the route component file.**

Create `apps/mesh/src/web/routes/cli-auth-success.tsx` with this exact content:

```tsx
import { useEffect } from "react";
import { AuthSplitLayout } from "@/web/components/auth-split-layout";
import { authClient } from "@/web/lib/auth-client";

/**
 * Landing page after the CLI's OAuth flow completes. The CLI's localhost
 * callback server 302-redirects the browser here. We read the freshly
 * established session to personalize the message, and silently attempt
 * to close the tab (browsers block this for non-JS-opened tabs, which is
 * fine — the page itself is the fallback).
 */
export default function CliAuthSuccessRoute() {
  const session = authClient.useSession();
  const email = session.data?.user?.email;

  // oxlint-disable-next-line ban-use-effect/ban-use-effect
  useEffect(() => {
    window.close();
  }, []);

  return (
    <AuthSplitLayout>
      <div className="space-y-3">
        <h1 className="text-3xl font-semibold tracking-tight">
          You're logged in{email ? <> as {email}</> : ""}.
        </h1>
        <p className="text-muted-foreground">
          You can return to your terminal.
        </p>
      </div>
    </AuthSplitLayout>
  );
}
```

Notes for the engineer:
- Why `useEffect` here? The codebase bans it generally because React 19's compiler handles most reactive cases automatically, but a one-shot, no-deps, side-effect-on-mount is exactly the case the escape hatch exists for. Same pattern as `AutoLogin` in `apps/mesh/src/web/routes/login.tsx`.
- We pass `<h1>` raw rather than wrapping in extra elements because `AuthSplitLayout` provides the outer `<main>` + `<section>` + max-width container.
- The right-side image of `AuthSplitLayout` defaults to `/onboarding-placeholder.png`, matching `/login` exactly.
- The session is read via `authClient.useSession()` exactly like `LoginRoute` does. If the session is still loading or absent, `email` is `undefined` and we render the non-personalized copy — no spinner, no flash to "logged in as undefined".

- [ ] **Step 2: Format.**

Run: `bun run fmt`

- [ ] **Step 3: Commit.**

```bash
git add apps/mesh/src/web/routes/cli-auth-success.tsx
git commit -m "feat(web): add /cli/auth-success route component"
```

---

## Task 4: Register `/cli/auth-success` in the router

**Files:**
- Modify: `apps/mesh/src/web/index.tsx`

- [ ] **Step 1: Add a `cliAuthSuccessRoute` definition.**

In `apps/mesh/src/web/index.tsx`, find the `loginRoute` block (around line 46) and add the new route definition immediately after it. The block to add:

```tsx
const cliAuthSuccessRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/cli/auth-success",
  component: lazyRouteComponent(
    () => import("./routes/cli-auth-success.tsx"),
  ),
});
```

- [ ] **Step 2: Add the new route to the root route tree.**

In the same file, find the `routeTree` definition near the bottom:

```tsx
const routeTree = rootRoute.addChildren([
  shellRouteTree,
  onboardingRoute,
  loginRoute,
  resetPasswordRoute,
  betterAuthRoutes,
  oauthCallbackRoute,
  oauthCallbackAiProviderRoute,
]);
```

Add `cliAuthSuccessRoute` to the array (insert after `loginRoute` for tidiness):

```tsx
const routeTree = rootRoute.addChildren([
  shellRouteTree,
  onboardingRoute,
  loginRoute,
  cliAuthSuccessRoute,
  resetPasswordRoute,
  betterAuthRoutes,
  oauthCallbackRoute,
  oauthCallbackAiProviderRoute,
]);
```

- [ ] **Step 3: Type-check.**

Run: `bun run check`

Expected: no new errors. If TanStack Router complains about the route path, double-check the path string is exactly `/cli/auth-success`.

- [ ] **Step 4: Format and commit.**

```bash
bun run fmt
git add apps/mesh/src/web/index.tsx
git commit -m "feat(web): register /cli/auth-success route"
```

---

## Task 5: End-to-end manual verification

This is a manual verification because we cannot reasonably automate a real browser-based OAuth round-trip in a unit test. Do this *before* declaring the work complete.

- [ ] **Step 1: Start the dev environment.**

Run: `bun run dev`

Wait for the client (port 4000) and server to be ready. Confirm the studio loads at `http://localhost:4000`.

- [ ] **Step 2: Confirm the route renders directly.**

Open `http://localhost:4000/cli/auth-success` in a browser **while logged in to the studio**.

Expected:
- The page renders with the same `AuthSplitLayout` chrome as `/login` (left-aligned content panel + right-side image).
- Heading reads "You're logged in as `<your-email>`."
- Subheading reads "You can return to your terminal."
- The browser will *attempt* to close the tab on mount. In most browsers this fails silently and the page just stays visible — this is expected behavior, not a bug.

- [ ] **Step 3: Confirm the route renders without a session.**

Open an incognito window (no session) and visit `http://localhost:4000/cli/auth-success`.

Expected: the page renders with the non-personalized copy ("You're logged in." — no email). No redirect to `/login`.

- [ ] **Step 4: Run the CLI login flow end-to-end against the local dev server.**

In a separate terminal:

```bash
bun run --cwd apps/mesh src/cli.ts auth login --target http://localhost:4000
```

(Use the actual entry point for the CLI in this repo — if it differs from `src/cli.ts`, check `apps/mesh/package.json` `"bin"` field. The exact invocation may be `bunx decocms auth login --target http://localhost:4000` if the package is linked.)

Expected:
- A browser tab opens to `http://localhost:4000/login?...`.
- After signing in, the browser ends up on `http://localhost:4000/cli/auth-success` with the personalized copy.
- The terminal prints `Logged in as <email>.` and exits 0.
- The session file is written under the data dir.

- [ ] **Step 5: Confirm `bun run lint` and `bun run check` pass.**

Run: `bun run lint && bun run check`

Expected: no errors. If lint flags the `useEffect` usage without the disable comment, check that the comment matches the exact pattern used in `login.tsx`.

- [ ] **Step 6: Final commit (only if any fixes were needed during verification).**

If the manual flow required any fixes:

```bash
bun run fmt
git add -A
git commit -m "fix(cli-auth-success): <describe fix>"
```

If no fixes were needed, skip this step.

---

## Summary of Commits Produced

1. `refactor(cli): redirect OAuth callback to hosted success URL`
2. `feat(cli): point OAuth callback to /cli/auth-success`
3. `feat(web): add /cli/auth-success route component`
4. `feat(web): register /cli/auth-success route`
5. (Optional) fix commit from manual verification.
