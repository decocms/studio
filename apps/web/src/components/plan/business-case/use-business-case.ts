/**
 * The business case a chat is building, read from the home volume.
 *
 * Refreshed by the chat's `data-business-case-updated` part (chat-context
 * invalidates this key) and polled, for a bounded time, only while the file
 * does not exist yet: the sandbox mount writes back a few seconds after the
 * agent's command.
 * A write that does not parse keeps the last good case on screen.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  parseBusinessCase,
  type BusinessCase,
} from "@decocms/shared/business-case";
import { useOrgFsDownloadUrl } from "@/hooks/use-org-fs";
import { KEYS } from "@/lib/query-keys";
import { useProjectContext } from "@/sdk";

const HOME_VOLUME = "home";
const POLL_WHILE_ABSENT_MS = 2000;
/** Three minutes: a chat that never writes its case stops being polled. */
const MAX_POLLS = 90;

export interface BusinessCaseRead {
  value: BusinessCase | null;
  /** The latest write did not parse; `value` is the one before it. */
  invalid: boolean;
  /** No file at the path yet. */
  absent: boolean;
}

/** One cache entry per case, so every reader shares it. */
export function businessCaseQueryKey(orgId: string, path: string) {
  return KEYS.orgFsText(orgId, HOME_VOLUME, path, "business-case");
}

export function useBusinessCase(path: string) {
  const { org } = useProjectContext();
  const queryClient = useQueryClient();
  const readUrl = useOrgFsDownloadUrl(HOME_VOLUME)(path);
  const queryKey = businessCaseQueryKey(org.id, path);

  return useQuery({
    queryKey,
    refetchInterval: (query) =>
      query.state.data?.absent === false ||
      query.state.dataUpdateCount + query.state.errorUpdateCount >= MAX_POLLS
        ? false
        : POLL_WHILE_ABSENT_MS,
    queryFn: async (): Promise<BusinessCaseRead> => {
      const previous =
        queryClient.getQueryData<BusinessCaseRead>(queryKey)?.value ?? null;
      const res = await fetch(readUrl, {
        credentials: "include",
        cache: "no-store",
      });
      if (res.status === 404) {
        return { value: previous, invalid: false, absent: true };
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const value = parseBusinessCase(await res.text());
      return value
        ? { value, invalid: false, absent: false }
        : { value: previous, invalid: true, absent: false };
    },
  });
}
