import { Navigate } from "@tanstack/react-router";
import { SplashScreen } from "@/components/splash-screen";
import { authClient } from "@/lib/auth-client";

function RedirectToLogin() {
  const currentUrl = window.location.pathname + window.location.search;

  // Don't set next to /login itself — that creates an infinite redirect loop
  // where each cycle double-encodes the previous next param until the URL
  // exceeds header size limits (HTTP 431).
  const isLoginUrl =
    currentUrl === "/login" || currentUrl.startsWith("/login?");
  const search = isLoginUrl ? {} : { next: currentUrl };

  return <Navigate to="/login" search={search} replace />;
}

/**
 * Signed in, or off to `/login`.
 *
 * Branches on the session store directly rather than composing better-auth-ui's
 * `<SignedIn>` / `<SignedOut>` / `<AuthLoading>`. Those three are independent
 * predicates over the same state, not an exclusive switch, and this component
 * wraps the WHOLE shell — so getting the overlap wrong is not a subtle bug:
 * with all three mounted, a pending state rendered a loader as a SIBLING of the
 * app, a stray spinner stacked above the shell with no height of its own. And
 * the pair without the loading branch had the opposite failure — `SignedIn`
 * needs data, `SignedOut` needs no-data AND settled, so `isPending` with no
 * data matched neither and painted a blank white page. better-auth sets exactly
 * that on any refetch of a session it does not have (`isPending:
 * currentValue.data === null`), including the one it fires right after
 * `signOut()`.
 *
 * An if/else over `useSession()` cannot have either failure: one branch runs.
 *
 * The loading branch is the `SplashScreen`, because this branch is still boot.
 * It is the ONE exception to "nothing below the boot boundary renders a splash"
 * (`layouts/boot-gate.tsx`), and it is not a relay: `BootGate` holds the splash
 * until the session settles, so the only way to reach this branch is the gate's
 * fail-open deadline — the session never answered, and the app mounted anyway
 * so `/login` and the error boundaries exist. Boot has not finished at that
 * point, and the honest picture of "still starting" is the splash. A bare
 * spinner alone on the viewport was read as a broken page, which is the bug
 * this replaced; the animation restarting once on that rare path is the price.
 */
export default function RequiredAuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { data: session, isPending } = authClient.useSession();

  if (session) return <>{children}</>;

  if (isPending) return <SplashScreen />;

  return <RedirectToLogin />;
}
