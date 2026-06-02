import type { ReactNode } from "react";
import { Loading01 } from "@untitledui/icons";
import { useCapabilities } from "@/web/hooks/use-capability";
import { NoPermissionState } from "@/web/components/no-permission-state";
import { CapabilityLoadError } from "@/web/components/capability-load-error";

interface RequirePrivilegedProps {
  /** Friendly label of the section, used in the no-permission heading. */
  area?: string;
  children: ReactNode;
}

/**
 * Route guard for screens that require a privileged built-in role (owner or
 * admin) rather than a capability — e.g. role management, which calls Better
 * Auth role APIs (listRoles/createRole/…) that are owner/admin-only. No custom
 * role can use those, so gating by a grantable capability would expose a broken
 * screen; this gates strictly on privilege.
 */
export function RequirePrivileged({ area, children }: RequirePrivilegedProps) {
  const { isPrivileged, loading, error } = useCapabilities();

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <Loading01 size={20} className="animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return <CapabilityLoadError />;
  }

  if (!isPrivileged) {
    return <NoPermissionState area={area} />;
  }

  return <>{children}</>;
}
