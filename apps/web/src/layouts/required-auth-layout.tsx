import { Navigate } from "@tanstack/react-router";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import { useT } from "@/i18n/use-t.ts";
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
 * The loading branch is a plain centred spinner rather than a `SplashScreen` —
 * this was one of the five sites that each mounted their own splash mid-boot
 * and restarted its animation, and the app has one splash now. Under `BootGate`
 * it cannot fire during boot anyway; it is for what happens afterwards.
 */
export default function RequiredAuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const t = useT();
  const { data: session, isPending } = authClient.useSession();

  if (session) return <>{children}</>;

  if (isPending) {
    return (
      <div className="flex min-h-dvh w-full items-center justify-center">
        <Spinner
          className="size-5 text-muted-foreground"
          label={t("common.loading")}
        />
      </div>
    );
  }

  return <RedirectToLogin />;
}
