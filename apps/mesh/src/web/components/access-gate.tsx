import type { ReactNode } from "react";
import { Loading01 } from "@untitledui/icons";
import { NoPermissionState } from "@/web/components/no-permission-state";
import { CapabilityLoadError } from "@/web/components/capability-load-error";

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
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <Loading01 size={20} className="animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return <CapabilityLoadError />;
  }

  if (!granted) {
    return <NoPermissionState area={area} />;
  }

  return <>{children}</>;
}
