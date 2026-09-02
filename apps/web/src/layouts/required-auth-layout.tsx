import { Navigate } from "@tanstack/react-router";
import { SignedIn, SignedOut } from "@daveyplate/better-auth-ui";

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
 * Signed in, or off to `/login`. There is deliberately no `AuthLoading` branch:
 * `BootGate` does not resolve until better-auth's session store has settled, so
 * by the time this renders the answer is already known. The branch used to
 * render a `SplashScreen`, which made it one more site that mounted its own
 * copy mid-boot — see `layouts/boot-gate.tsx`.
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
    </>
  );
}
