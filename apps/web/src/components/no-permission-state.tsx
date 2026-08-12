import type { ReactNode } from "react";
import { Lock01 } from "@untitledui/icons";
import { Link, useParams } from "@tanstack/react-router";
import { Button } from "@decocms/ui/components/button.tsx";

interface NoPermissionStateProps {
  /** Short label describing the section the user tried to open. */
  area?: string;
  /** Optional override for the body copy. */
  description?: string;
  /**
   * Optional override for the footer action. Defaults to a link back to the
   * org profile page — which only resolves under `/shell/$org`, so instance-
   * level callers (e.g. the deployment-admin dashboard) must pass their own.
   */
  action?: ReactNode;
}

/** Org-scoped default action; isolated so its `$org` param lookup never runs
 *  when a caller supplies its own action outside an org route. */
function ProfileLink() {
  const { org } = useParams({ from: "/shell/$org" });
  return (
    <Button variant="outline" size="sm" asChild>
      <Link to="/$org/settings/profile" params={{ org }}>
        Go to your profile
      </Link>
    </Button>
  );
}

/**
 * Full-panel empty state shown when a member's role doesn't include a
 * capability (used by RequireCapability). Offers a way back to the always-
 * accessible profile page, or a caller-supplied action.
 */
export function NoPermissionState({
  area,
  description,
  action,
}: NoPermissionStateProps) {
  const title = area ? `No access to ${area}` : "No access";
  const body =
    description ??
    "Your role doesn't include permission for this section. Ask an organization admin to update your role if you need it.";

  return (
    <div className="flex h-full min-h-[60vh] flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Lock01 size={28} />
      </div>
      <div className="space-y-1">
        <h3 className="text-lg font-medium">{title}</h3>
        <p className="mx-auto max-w-sm text-sm text-muted-foreground">{body}</p>
      </div>
      {action ?? <ProfileLink />}
    </div>
  );
}
