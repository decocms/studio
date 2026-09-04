import { useQuery } from "@tanstack/react-query";
import type { OrgNoticePublic } from "@decocms/shared/organization/notice";
import { KEYS } from "../lib/query-keys";

interface OrgNoticeResponse {
  notice: OrgNoticePublic | null;
}

/**
 * The billing notice a deployment admin pinned on this org: a `warn` renders a
 * banner, a `block` replaces the org's UI (see `blocked-org-screen`).
 *
 * A failed read resolves to "no notice" rather than throwing — the shell must
 * open even when this endpoint is unhappy, and the server enforces a block on
 * its own regardless of what the client renders.
 */
export function useOrgNotice(orgSlug: string | undefined) {
  return useQuery({
    queryKey: KEYS.orgNotice(orgSlug ?? ""),
    queryFn: async (): Promise<OrgNoticePublic | null> => {
      const response = await fetch(`/api/${orgSlug}/notice`, {
        credentials: "include",
      });
      if (!response.ok) return null;
      const body = (await response.json()) as OrgNoticeResponse;
      return body.notice ?? null;
    },
    enabled: !!orgSlug,
    staleTime: 60_000,
  });
}
