import { Navigate, useParams, useSearch } from "@tanstack/react-router";
import { AuthLoading, SignedIn, SignedOut } from "@daveyplate/better-auth-ui";
import { SplashScreen } from "@/web/components/splash-screen";
import { authClient } from "@/web/lib/auth-client";

function RedirectToLogin({ appName }: { appName: string }) {
  const search = useSearch({ strict: false });

  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) {
    if (value !== undefined && value !== null) {
      searchParams.set(key, String(value));
    }
  }
  const searchString = searchParams.toString();
  const encodedAppName = encodeURIComponent(appName);
  const nextUrl = `/store/${encodedAppName}${searchString ? `?${searchString}` : ""}`;

  return <Navigate to="/login" search={{ next: nextUrl }} replace />;
}

function StoreInviteRedirect() {
  const { appName } = useParams({ strict: false }) as { appName: string };
  const search = useSearch({ strict: false }) as Record<string, string>;
  const { data: organizations, isPending } = authClient.useListOrganizations();

  if (isPending) {
    return <SplashScreen />;
  }

  const org = organizations?.[0];
  if (!org) {
    return <Navigate to="/" replace />;
  }

  return (
    <Navigate
      to="/$org/store/$appName"
      params={{ org: org.slug, appName }}
      search={search}
      replace
    />
  );
}

export default function StoreInviteRoute() {
  const { appName } = useParams({ strict: false }) as { appName: string };

  return (
    <>
      <AuthLoading>
        <SplashScreen />
      </AuthLoading>

      <SignedIn>
        <StoreInviteRedirect />
      </SignedIn>

      <SignedOut>
        <RedirectToLogin appName={appName} />
      </SignedOut>
    </>
  );
}
