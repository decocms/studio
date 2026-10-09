/**
 * useAgentEntryThreads — the current user's most recent threads on one agent,
 * read straight from the server.
 *
 * The shared thread feed is the user's latest page across the whole org, so a
 * project's last draft drops out of it once enough chats elsewhere are newer.
 * Entering the project then resolved no entry thread and minted a fresh draft
 * next to the existing one. This scoped read is the fallback the entry resolver
 * consults before minting.
 *
 * Fail-open: an error resolves to no threads, so entry falls back to minting as
 * it did before rather than blocking the project.
 */

import { useQuery } from "@tanstack/react-query";
import type { Task } from "@/components/chat/task/types";
import { authClient } from "@/lib/auth-client";
import { KEYS } from "@/lib/query-keys";
import { useStudioTools } from "@/lib/studio-tools";
import { useProjectContext } from "@/sdk";

/** Covers the production and other-runtime threads the resolver skips. */
const ENTRY_THREADS_LIMIT = 50;

export type AgentEntryThreads =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; threads: Task[] };

export function useAgentEntryThreads(
  virtualMcpId: string,
  enabled: boolean,
): AgentEntryThreads {
  const { org } = useProjectContext();
  const studio = useStudioTools();
  const { data: session } = authClient.useSession();
  const userId = session?.user?.id ?? "";

  const query = useQuery({
    queryKey: KEYS.agentEntryThreads(org.id, userId, virtualMcpId),
    enabled: enabled && !!userId,
    // Overrides the app's 1-minute default: every entry re-reads the drafts.
    staleTime: 0,
    queryFn: async (): Promise<Task[]> => {
      try {
        const result = await studio.call("COLLECTION_THREADS_LIST", {
          limit: ENTRY_THREADS_LIMIT,
          offset: 0,
          orderBy: [{ field: ["updated_at"], direction: "desc" }],
          where: {
            hidden: false,
            created_by: "me",
            virtual_mcp_id: virtualMcpId,
          },
        });
        return result.items;
      } catch {
        return [];
      }
    },
  });

  if (!enabled || !userId) return { status: "idle" };
  // A list cached by an earlier entry can predate drafts made since. Enabling
  // over stale data reports `isFetching` on that same render, so wait for it.
  if (!query.data || query.isFetching) return { status: "loading" };
  return { status: "ready", threads: query.data };
}
