import { OrganizationsHome } from "@/web/components/organizations-home";
import { useAuthConfig } from "@/web/providers/auth-config-provider";
import { authClient } from "@/web/lib/auth-client";
import { Navigate } from "@tanstack/react-router";
import { SplashScreen } from "@/web/components/splash-screen";

export default function App() {
  const authConfig = useAuthConfig();
  const { data: organizations, isPending } = authClient.useListOrganizations();

  // In local mode, skip org selection — go straight to the first (only) org
  if (authConfig.localMode) {
    if (isPending) return <SplashScreen />;

    const firstOrg = organizations?.[0];
    if (firstOrg?.slug) {
      return <Navigate to={`/${firstOrg.slug}/org-admin`} replace />;
    }
  }

  return (
    <div className="min-h-full">
      <OrganizationsHome />
    </div>
  );
}
