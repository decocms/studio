/**
 * The boot gate: one promise, so the app has one splash.
 *
 * The splash plays a definite animation — a wave that fills the mark once — so
 * it is only honest if the element playing it is mounted once. It was not. Boot
 * relayed between five independent splash render sites: the providers' Suspense
 * fallback, the root route's own, `shellLayout`'s and `orgLayout`'s router
 * pending states, and `RequiredAuthLayout`'s `AuthLoading` branch. Each handoff
 * unmounted one element and mounted a different one elsewhere in the tree, and
 * the animation restarted from zero — measured at two and three restarts per
 * boot, in dev AND in a production build, with a blank frame in the seam where
 * the next boundary's `defaultPendingMs` had not elapsed yet.
 *
 * A Suspense fallback is reused only while its boundary stays suspended, so the
 * fix is structural rather than cosmetic: ONE boundary, in
 * `providers/providers.tsx`, wrapping everything including `<RouterProvider>`,
 * and nothing below it renders anything splash-shaped. This gate is what keeps
 * that one boundary suspended for the whole boot — it reads a module-scope
 * promise with `use()`, so the router does not mount until the app is ready to
 * paint, and no router pending state can arm behind the splash's back.
 *
 * The promise waits on exactly two things, which between them cover all five
 * old sites:
 *
 *   - `router.load()` — TanStack's own readiness primitive. It runs the
 *     `beforeLoad` chain and loads every matched route's chunk for the entry
 *     URL, which is what `shellLayout`, `orgLayout`, `homeRoute` and
 *     `onboardingRoute` each used to show their own splash for. Awaiting it
 *     here is also why the splash can leave straight onto a painted shell:
 *     resolving the gate on a hand-listed subset instead left a blank frame
 *     while the router did the rest.
 *   - the session, because `RequiredAuthLayout` blanked to a splash of its own
 *     while better-auth's store was pending.
 *
 * Both run concurrently, and neither is work this app was not already doing —
 * it is the same boot, with the loader on top of it held still.
 *
 * What deliberately stays OUT is anything the main panel fetches for itself:
 * that has its own loading state (`main-panel-boundary.tsx`), and holding the
 * splash up for it would trade one wrong transition for a slower boot. The
 * promise is created once at module scope and never re-armed, so once it
 * settles `use()` returns synchronously forever: the splash is boot-only by
 * construction, not by timing.
 */

import { use, type ReactNode } from "react";
import { authClient } from "@/lib/auth-client";
import { router } from "@/router";

/**
 * Resolve once better-auth's session store has settled, signed in or out.
 *
 * `authClient.getSession()` is deliberately NOT used: it issues its own request
 * and leaves the `useSession` store untouched, so the store would still report
 * `isPending` on the shell's first render — the state that used to paint a
 * second splash. Subscribing is what starts the store's fetch, so this settles
 * it and brings it forward at the same time. The subscription is never torn
 * down: it is one listener for the life of the page, and dropping it would let
 * nanostores unmount the atom and take better-auth's session refresh manager
 * with it.
 *
 * It also FAILS OPEN. `isPending` only clears from better-auth's own
 * success/error paths, and its fetch carries no timeout — so a request that
 * opens a socket and is never answered (a captive portal, a black-holed proxy)
 * left this promise unresolved forever. That mattered more here than at the
 * five boundaries this replaced: they each failed open with the router already
 * mounted, whereas this gate sits ABOVE `<RouterProvider>`, so the same hang
 * meant an infinite splash with no route tree, no error boundary and `/login`
 * unreachable. After the deadline the app mounts with the session still
 * pending, which `RequiredAuthLayout` renders as a loader rather than a blank.
 */
const SESSION_SETTLE_TIMEOUT_MS = 8_000;

function sessionSettled(): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, SESSION_SETTLE_TIMEOUT_MS);
    authClient.$store.listen("session", (state: unknown) => {
      if (state && typeof state === "object" && "isPending" in state) {
        if (!state.isPending) {
          clearTimeout(timer);
          resolve();
        }
      }
    });
  });
}

let bootPromise: Promise<void> | undefined;

/**
 * A failed route load is the route tree's to report — its error components run
 * under the shell — so it settles the gate rather than holding the splash up in
 * front of the error.
 */
function routerReady(): Promise<void> {
  return router.load().catch(() => undefined);
}

function boot(): Promise<void> {
  bootPromise ??= Promise.all([sessionSettled(), routerReady()]).then(
    () => undefined,
  );
  return bootPromise;
}

/** Suspends until the app can paint. Belongs inside the one splash boundary and
 *  above `<RouterProvider>`. */
export function BootGate({ children }: { children: ReactNode }) {
  use(boot());
  return children;
}
