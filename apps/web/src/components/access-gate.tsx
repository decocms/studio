import type { ReactNode } from "react";
import { NoPermissionState } from "@/components/no-permission-state";
import { PanelLoading } from "@/layouts/main-panel-boundary";
import { CapabilityLoadError } from "@/components/capability-load-error";

interface AccessGateProps {
  /** Whether access is granted (computed by the caller from its own signal). */
  granted: boolean;
  loading: boolean;
  /** True when the capability lookup failed (network/server error). */
  error: boolean;
  /** Friendly label of the section, used in the no-permission heading. */
  area?: string;
  children: ReactNode;
}

/**
 * Shared render for the route guards: a spinner while access resolves, a
 * retryable error on lookup failure (never a false denial), the no-access panel
 * when denied, and the children when granted. RequireCapability and
 * RequirePrivileged differ only in how they compute `granted`, so the rendering
 * lives here once.
 */
export function AccessGate({
  granted,
  loading,
  error,
  area,
  children,
}: AccessGateProps) {
  if (loading) {
    return <PanelLoading />;
  }

  if (error) {
    return <CapabilityLoadError />;
  }

  if (!granted) {
    return <NoPermissionState area={area} />;
  }

  return <>{children}</>;
}
