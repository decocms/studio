import { Navigate, useParams } from "@tanstack/react-router";
import { Loading01 } from "@untitledui/icons";
import { useCapabilities, type CapabilityId } from "@/web/hooks/use-capability";

/**
 * Capability-aware /settings index. Redirects each member to the first
 * settings tab their role can open. Profile is always accessible, so it's the
 * guaranteed fallback — a member never lands on a no-access page.
 */
export default function SettingsIndexRedirect() {
  const { org } = useParams({ from: "/shell/$org" });
  const { capabilities, isPrivileged, loading } = useCapabilities();

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <Loading01 size={20} className="animate-spin text-muted-foreground" />
      </div>
    );
  }

  const can = (id: CapabilityId) => isPrivileged || capabilities[id] === true;

  if (can("org:manage")) {
    return <Navigate to="/$org/settings/general" params={{ org }} replace />;
  }
  if (can("ai-providers:manage")) {
    return (
      <Navigate to="/$org/settings/ai-providers" params={{ org }} replace />
    );
  }
  if (can("automations:manage")) {
    return (
      <Navigate to="/$org/settings/automations" params={{ org }} replace />
    );
  }
  if (can("registry:manage")) {
    return <Navigate to="/$org/settings/store" params={{ org }} replace />;
  }
  if (can("monitoring:view")) {
    return <Navigate to="/$org/settings/monitor" params={{ org }} replace />;
  }
  if (can("members:manage")) {
    return <Navigate to="/$org/settings/members" params={{ org }} replace />;
  }
  return <Navigate to="/$org/settings/profile" params={{ org }} replace />;
}
