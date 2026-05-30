import { KEYS } from "@/web/lib/query-keys";
import { useSuspenseQuery } from "@tanstack/react-query";

export interface OrgAccessStatusOrg {
  id: string;
  name: string;
  slug: string;
  logo: string | null;
  domain?: string;
}

export type OrgAccessStatus =
  | { status: "member"; organization: OrgAccessStatusOrg }
  | {
      status: "pending-invite";
      invitation: { id: string };
      organization: OrgAccessStatusOrg;
    }
  | { status: "auto-domain-join"; organization: OrgAccessStatusOrg }
  | { status: "no-access"; organization: OrgAccessStatusOrg }
  | { status: "not-found" };

export function useOrgAccessStatus(slug: string) {
  return useSuspenseQuery({
    queryKey: KEYS.orgAccessStatus(slug),
    queryFn: async (): Promise<OrgAccessStatus> => {
      const res = await fetch(
        `/api/auth/custom/org-access-status/${encodeURIComponent(slug)}`,
        { credentials: "include" },
      );
      if (!res.ok) {
        throw new Error(`org-access-status failed (${res.status})`);
      }
      return (await res.json()) as OrgAccessStatus;
    },
    refetchOnWindowFocus: false,
  });
}
