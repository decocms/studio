import { Navigate, useParams } from "@tanstack/react-router";
import {
  AuthLoading,
  AuthView,
  SignedIn,
  SignedOut,
} from "@daveyplate/better-auth-ui";
import { SplashScreen } from "@/components/splash-screen";

/**
 * Redirect logged-out users to /login preserving the current URL as `next`
 * so they return here after authenticating.
 */
function RedirectToLogin() {
  const next = window.location.pathname + window.location.search;
  return <Navigate to="/login" search={{ next }} replace />;
}

export default function AuthPage() {
  const { pathname } = useParams({ from: "/auth/$pathname" });

  // For accept-invitation, redirect logged-out users to our own /login page
  // instead of the default /auth/sign-in form from better-auth-ui.
  if (pathname === "accept-invitation") {
    return (
      <>
        <AuthLoading>
          <SplashScreen />
        </AuthLoading>

        <SignedIn>
          <main className="container mx-auto flex grow flex-col items-center justify-center gap-3 self-center p-4 md:p-6">
            <AuthView pathname="accept-invitation" />
          </main>
        </SignedIn>

        <SignedOut>
          <RedirectToLogin />
        </SignedOut>
      </>
    );
  }

  return (
    <main className="container mx-auto flex grow flex-col items-center justify-center gap-3 self-center p-4 md:p-6">
      <AuthView pathname={pathname} />
    </main>
  );
}
