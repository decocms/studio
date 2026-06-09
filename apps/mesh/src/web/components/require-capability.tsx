import type { ReactNode } from "react";
import { useCapability, type CapabilityId } from "@/web/hooks/use-capability";
import { AccessGate } from "@/web/components/access-gate";

interface RequireCapabilityProps {
  capability: CapabilityId;
  /** Friendly label of the section, used in the no-permission heading. */
  area?: string;
  children: ReactNode;
}

/**
 * Route-level guard. Renders children only when the current user has the
 * capability (spinner while resolving, retryable error on lookup failure,
 * no-access panel when denied). The guarded subtree isn't mounted until access
 * is confirmed, so the inner view's data hooks never fire for a denied user.
 */
export function RequireCapability({
  capability,
  area,
  children,
}: RequireCapabilityProps) {
  const { granted, loading, error } = useCapability(capability);
  return (
    <AccessGate granted={granted} loading={loading} error={error} area={area}>
      {children}
    </AccessGate>
  );
}
