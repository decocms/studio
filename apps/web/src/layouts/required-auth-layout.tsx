import { Navigate } from "@tanstack/react-router";
import { AuthLoading, SignedIn, SignedOut } from "@daveyplate/better-auth-ui";
import { PanelLoading } from "@/layouts/main-panel-boundary";

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
 * All THREE states are handled, and the third is not hypothetical: `SignedIn`
 * renders only with session data, `SignedOut` only when there is none AND the
 * store is settled, so `isPending` with no data renders neither — a blank white
 * page. better-auth sets exactly that on any post-boot refetch of a session it
 * does not have, including the one it fires right after `signOut()`, and after
 * this gate's own settle timeout. Boot is not the only time this component
 * renders, which is what the previous version assumed.
 *
 * The loading branch is `PanelLoading`, deliberately NOT a `SplashScreen`: this
 * was one of the five sites that each mounted their own splash mid-boot and
 * restarted its animation, and the app has one splash now. Under `BootGate`
 * this branch cannot fire during boot anyway — only afterwards, where a panel
 * loader is the honest shape.
 */
export default function RequiredAuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <SignedIn>{children}</SignedIn>

      <SignedOut>
        <RedirectToLogin />
      </SignedOut>

      <AuthLoading>
        <PanelLoading />
      </AuthLoading>
    </>
  );
}
