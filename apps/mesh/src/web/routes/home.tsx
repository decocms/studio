import { OrganizationsHome } from "@/web/components/organizations-home";
import { useAuthConfig } from "@/web/providers/auth-config-provider";
import { Navigate } from "@tanstack/react-router";

export default function App() {
  const authConfig = useAuthConfig();

  // In local mode, skip the org selection and go directly to the Local org
  if (authConfig.localMode) {
    return <Navigate to="/local/org-admin" replace />;
  }

  return (
    <div className="min-h-full">
      <OrganizationsHome />
    </div>
  );
}
