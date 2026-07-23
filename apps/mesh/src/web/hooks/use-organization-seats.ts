/**
 * Per-seat billing hooks: the org's billing identity + who holds paid seats
 * (ORGANIZATION_SEATS_GET), and the staged-changes apply
 * (ORGANIZATION_SEATS_SET — invoiced orgs only until the Stripe checkout
 * path lands). Seats are monetization, orthogonal to roles.
 */

import { useProjectContext } from "@decocms/mesh-sdk";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KEYS } from "@/web/lib/query-keys";
import { callStudioTool } from "@/web/lib/studio-tools";

export type SeatKind = "paid" | "free";

export interface OrganizationSeats {
  /** null = org predates billing entirely (treated as legacy — no seats). */
  billing: {
    legacy: boolean;
    billingMode: string;
    status: string;
    includedReportUrl: string | null;
  } | null;
  paidSeatUserIds: string[];
}

export function useOrganizationSeats() {
  const { org } = useProjectContext();

  return useQuery({
    queryKey: KEYS.organizationSeats(org.id),
    queryFn: async (): Promise<OrganizationSeats> => {
      // Best-effort: a failed read renders the members page without the seat
      // column instead of erroring it (same posture as org-settings).
      try {
        return (await callStudioTool(
          org.slug,
          "ORGANIZATION_SEATS_GET",
          {},
        )) as OrganizationSeats;
      } catch {
        return { billing: null, paidSeatUserIds: [] };
      }
    },
    staleTime: 60_000,
  });
}

export function useSetSeats() {
  const { org } = useProjectContext();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (seats: Array<{ userId: string; seat: SeatKind }>) => {
      return (await callStudioTool(org.slug, "ORGANIZATION_SEATS_SET", {
        seats,
      })) as { applied: Array<{ userId: string; seat: SeatKind }> };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: KEYS.organizationSeats(org.id),
      });
    },
  });
}
