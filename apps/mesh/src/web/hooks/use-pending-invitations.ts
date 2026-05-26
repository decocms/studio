import { AuthUIContext } from "@daveyplate/better-auth-ui";
import { useContext } from "react";
import type { Invitation } from "@/web/components/sidebar/types";

export type { Invitation };

export function usePendingInvitations(): Invitation[] {
  const authUi = useContext(AuthUIContext);
  const { data } = authUi.hooks.useListUserInvitations();
  const invitations = (data ?? []) as Invitation[];
  return invitations.filter(
    (inv) => inv.status === "pending" && new Date(inv.expiresAt) > new Date(),
  );
}
