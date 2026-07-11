/**
 * useMyThreads — the cross-org aggregate that powers the "MY deco" home.
 *
 * Threads are strictly org-scoped server-side (COLLECTION_THREADS_LIST requires
 * an org), so there is no single "all my threads" endpoint. We fan out instead:
 * one `COLLECTION_THREADS_LIST { where: { created_by: "me" } }` per org the user
 * belongs to, each over that org's self-MCP client, then merge and sort client
 * side. No new backend tool, no migration — every call is membership-checked by
 * the org-scoped route.
 *
 * Clients are reused from the shared react-query cache (same key as
 * `useMCPClient`), so this doesn't open N fresh transports per render.
 */
import { useQueries, useQueryClient } from "@tanstack/react-query";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { mcpClientQueryOptions, SELF_MCP_ALIAS_ID } from "@decocms/mesh-sdk";
import { useActiveOrganizations } from "@/web/lib/auth-client";
import { KEYS } from "@/web/lib/query-keys";
import type { Task } from "@/web/components/chat/task/types";
import type { StatusKey } from "@/web/lib/task-status";

/** How many recent threads to pull per org. The home is a "what's moving now"
 * surface, not an archive — recent-per-org merged is plenty for v1. */
const PER_ORG_LIMIT = 25;

/** Attention order: what needs me first, done last. */
const ATTENTION_RANK: Record<StatusKey, number> = {
  requires_action: 0,
  in_progress: 1,
  failed: 2,
  expired: 3,
  completed: 4,
};

export interface MyThreadOrg {
  id: string;
  slug: string;
  name: string;
  logo?: string | null;
}

export interface MyThreadAgent {
  title: string;
  icon: string | null;
}

export interface MyThread {
  thread: Task;
  org: MyThreadOrg;
  /** Resolved from the org's VIRTUAL_MCP collection so cards can show the agent
   * without an org-scoped context (the home is org-less). */
  agent: MyThreadAgent | null;
}

export interface UseMyThreadsResult {
  threads: MyThread[];
  /** True while the first results are still loading and nothing is shown yet. */
  isLoading: boolean;
  /** True once at least one org has resolved (progressive reveal). */
  hasAny: boolean;
  /** Orgs whose fetch failed — surfaced non-fatally so the rest still render. */
  erroredOrgs: MyThreadOrg[];
  /** The user's orgs, for filter chips. */
  orgs: MyThreadOrg[];
}

function rankOf(status: Task["status"]): number {
  return ATTENTION_RANK[(status ?? "completed") as StatusKey] ?? 5;
}

/** requires_action → in_progress → … → completed, then most-recent first. */
function compareThreads(a: MyThread, b: MyThread): number {
  const byRank = rankOf(a.thread.status) - rankOf(b.thread.status);
  if (byRank !== 0) return byRank;
  return (b.thread.updated_at ?? "").localeCompare(a.thread.updated_at ?? "");
}

function unwrap<T>(result: unknown): T {
  if ((result as { isError?: boolean }).isError) {
    throw new Error("tool call failed");
  }
  return ((result as { structuredContent?: unknown }).structuredContent ??
    result) as T;
}

/** Map of virtual_mcp_id → agent display info, so cards render the agent name
 * and icon without the org-scoped `useVirtualMCP` context. */
async function fetchOrgAgents(
  client: Client,
): Promise<Map<string, MyThreadAgent>> {
  try {
    const result = await client.callTool({
      name: "COLLECTION_VIRTUAL_MCP_LIST",
      arguments: { limit: 200, offset: 0 },
    });
    const payload = unwrap<{
      items?: { id: string; title?: string; icon?: string | null }[];
    }>(result);
    const map = new Map<string, MyThreadAgent>();
    for (const item of payload.items ?? []) {
      map.set(item.id, {
        title: item.title ?? "Agent",
        icon: item.icon ?? null,
      });
    }
    return map;
  } catch {
    // Agent enrichment is best-effort — a card without an agent name is fine.
    return new Map();
  }
}

async function fetchOrgThreads(
  client: Client,
  org: MyThreadOrg,
): Promise<MyThread[]> {
  const [threadsResult, agents] = await Promise.all([
    client.callTool({
      name: "COLLECTION_THREADS_LIST",
      arguments: {
        limit: PER_ORG_LIMIT,
        offset: 0,
        orderBy: [{ field: ["updated_at"], direction: "desc" }],
        where: { hidden: false, created_by: "me" },
      },
    }),
    fetchOrgAgents(client),
  ]);
  const payload = unwrap<{ items?: Task[] }>(threadsResult);
  return (payload.items ?? []).map((thread) => ({
    thread,
    org,
    agent: thread.virtual_mcp_id
      ? (agents.get(thread.virtual_mcp_id) ?? null)
      : null,
  }));
}

export function useMyThreads(): UseMyThreadsResult {
  const queryClient = useQueryClient();
  const { data: organizations } = useActiveOrganizations();

  const orgList = (organizations ?? []) as Array<{
    id: string;
    slug: string;
    name: string;
    logo?: string | null;
  }>;
  const orgs: MyThreadOrg[] = orgList.map((o) => ({
    id: o.id,
    slug: o.slug,
    name: o.name,
    logo: o.logo ?? null,
  }));

  return useQueries({
    queries: orgs.map((org) => ({
      queryKey: KEYS.myThreads(org.id),
      queryFn: async (): Promise<MyThread[]> => {
        const client = await queryClient.ensureQueryData(
          mcpClientQueryOptions({
            connectionId: SELF_MCP_ALIAS_ID,
            orgId: org.id,
            orgSlug: org.slug,
          }),
        );
        return fetchOrgThreads(client, org);
      },
      staleTime: 30_000,
    })),
    combine: (results): UseMyThreadsResult => {
      const threads = results.flatMap((r) => r.data ?? []).sort(compareThreads);
      const settled = results.filter((r) => !r.isPending);
      const erroredOrgs = results
        .map((r, i) => (r.isError ? orgs[i] : null))
        .filter((o): o is MyThreadOrg => o !== null);
      return {
        threads,
        isLoading: orgs.length > 0 && settled.length === 0,
        hasAny: settled.length > 0,
        erroredOrgs,
        orgs,
      };
    },
  });
}
