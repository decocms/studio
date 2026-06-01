import type { ReactNode } from "react";
import { Loading01 } from "@untitledui/icons";
import { useCapability, type CapabilityId } from "@/web/hooks/use-capability";
import { NoPermissionState } from "@/web/components/no-permission-state";

interface RequireCapabilityProps {
  capability: CapabilityId;
  /** Friendly label of the section, used in the no-permission heading. */
  area?: string;
  children: ReactNode;
}

/**
 * Route-level guard. Renders children only when the current user has the
 * capability, a clean no-permission state otherwise, and a spinner while the
 * capability resolves (so the page doesn't flicker). Because the guarded
 * subtree isn't mounted until access is confirmed, the inner view's data
 * hooks never fire for a denied user.
 */
export function RequireCapability({
  capability,
  area,
  children,
}: RequireCapabilityProps) {
  const { granted, loading } = useCapability(capability);

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <Loading01 size={20} className="animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!granted) {
    return <NoPermissionState area={area} />;
  }

  return <>{children}</>;
}
