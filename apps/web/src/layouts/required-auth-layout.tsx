import { Navigate } from "@tanstack/react-router";
import { AuthLoading, SignedIn, SignedOut } from "@daveyplate/better-auth-ui";
import { SplashScreen } from "@/components/splash-screen";

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

export default function RequiredAuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <AuthLoading>
        <SplashScreen />
      </AuthLoading>

      <SignedIn>{children}</SignedIn>

      <SignedOut>
        <RedirectToLogin />
      </SignedOut>
    </>
  );
}
