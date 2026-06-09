import type { ReactNode } from "react";
import { useCapabilities } from "@/web/hooks/use-capability";
import { AccessGate } from "@/web/components/access-gate";

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
  return (
    <AccessGate
      granted={isPrivileged}
      loading={loading}
      error={error}
      area={area}
    >
      {children}
    </AccessGate>
  );
}
