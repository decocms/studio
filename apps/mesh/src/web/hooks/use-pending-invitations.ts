import { AuthUIContext } from "@daveyplate/better-auth-ui";
import { useContext } from "react";

export interface Invitation {
  id: string;
  organizationId: string;
  organizationName?: string;
  email: string;
  role: string;
  status: string;
  expiresAt: Date;
}

export function usePendingInvitations(): Invitation[] {
  const authUi = useContext(AuthUIContext);
  const { data } = authUi.hooks.useListUserInvitations();
  const invitations = (data ?? []) as Invitation[];
  return invitations.filter(
    (inv) => inv.status === "pending" && new Date(inv.expiresAt) > new Date(),
  );
}
