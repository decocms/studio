import { AuthUIContext } from "@daveyplate/better-auth-ui";
import { useContext } from "react";
import type { Invitation } from "@/components/sidebar/types";

export type { Invitation };

export function usePendingInvitations(): {
  invitations: Invitation[];
  /** Re-fetch the underlying invitation list — call after accept/decline so
   *  the row (and the breadcrumb dot) clear without a full page reload. */
  refetch: () => void;
} {
  const authUi = useContext(AuthUIContext);
  // better-auth exposes its hooks on the context object, so the callee is
  // not a statically-known hook identity. The call is still unconditional
  // and top-level, which is what Rules of Hooks actually requires.
  // oxlint-disable-next-line react/hooks
  const { data, refetch } = authUi.hooks.useListUserInvitations();
  const invitations = ((data ?? []) as Invitation[]).filter(
    (inv) => inv.status === "pending" && new Date(inv.expiresAt) > new Date(),
  );
  return { invitations, refetch: () => refetch?.() };
}
