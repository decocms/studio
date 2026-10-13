/**
 * Main's schema answer for a project: `isV8Schema` on main's
 * `.deco/schema.gen.json`, computed by the server (`POST
 * /api/:org/blocks-major/:id`, an ETag-cached head read and a per-commit
 * answer there) and read once per project per session here, again only when
 * the server says main changed since (`main-schema-changed.ts`).
 *
 * This is how the web app knows a project is a Blocks v8 site. The
 * project's `metadata.blocksMajor` marker is only the server's cache of this
 * same answer, never a v8 answer on its own: it only tells an unreadable
 * main on a site last found v8 (`"error"`, which waits) from any other one
 * (`"v7"`). When the answer differs from the marker this page holds, the
 * server just rewrote it, so the project is re-read for the surfaces that
 * still show the server's runtime default.
 *
 * - `"loading"`: not known yet. The editor waits; it never shows the v7 path
 *   first and switches.
 * - `"v8"` / `"v7"`: main's schema is (not) a Blocks v8 one. A project
 *   without a repository has no main: `"v7"`, with no request.
 * - `"error"`: main couldn't be read, on a project the server last found to
 *   be v8 (its marker). Re-polled until it can; the v8 editor waits.
 *
 * A failed read on any other project is `"v7"`: a site whose schema can't be
 * confirmed v8 behaves as on main (the v7 editor, preview and Local tunnel,
 * which read the running site, not main), never an indefinite wait. The read
 * is still re-polled, so a v8 answer that arrives later takes over. The
 * marker is only a hint here, never a v8 answer on its own.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { isBlocksV8Project } from "@decocms/shared/blocks-major";
import { agentHasClonableSource } from "@/lib/agent-capabilities";
import { KEYS } from "@/lib/query-keys";
import { useProjectContext, useVirtualMCP } from "@/sdk";
import { invalidateCollectionQueries } from "@/sdk/hooks/use-collections";

export type MainSchemaAnswer = "v8" | "v7" | "loading" | "error";

/** How often a failed read of main's schema is retried. */
const MAIN_SCHEMA_RETRY_MS = 5_000;

/** The server's answer: `isV8: null` when the project has no repository. */
export async function fetchMainSchemaV8(
  orgSlug: string,
  virtualMcpId: string,
  doFetch: (input: string, init: RequestInit) => Promise<Response> = (
    input,
    init,
  ) => fetch(input, init),
): Promise<boolean> {
  const res = await doFetch(
    `/api/${orgSlug}/blocks-major/${encodeURIComponent(virtualMcpId)}`,
    { method: "POST", cache: "no-store" },
  );
  if (!res.ok) throw new Error(`main's schema: HTTP ${res.status}`);
  const body = (await res.json().catch(() => null)) as {
    isV8?: unknown;
  } | null;
  if (body?.isV8 === null) return false;
  if (typeof body?.isV8 !== "boolean") {
    throw new Error("main's schema: unexpected answer");
  }
  return body.isV8;
}

/** The answer from the query's state (pure, for tests). */
export function mainSchemaAnswer(input: {
  /** Whether there is a project with a repository to ask about. */
  asks: boolean;
  /** Whether there is a project at all (none: nothing to read, `"v7"`). */
  hasProject: boolean;
  data: boolean | undefined;
  isError: boolean;
  /** The server's marker (`isBlocksV8Project`): main was last found v8. */
  marked: boolean;
}): MainSchemaAnswer {
  if (!input.hasProject || !input.asks) return "v7";
  if (input.data !== undefined) return input.data ? "v8" : "v7";
  if (!input.isError) return "loading";
  // Unreadable: only a site last known to be v8 waits; any other one is v7.
  return input.marked ? "error" : "v7";
}

export function useMainSchemaV8(
  virtualMcpId: string | null | undefined,
): MainSchemaAnswer {
  const { org } = useProjectContext();
  const queryClient = useQueryClient();
  const project = useVirtualMCP(virtualMcpId);
  const projectId = project?.id ?? "";
  const marked = isBlocksV8Project(project?.metadata);
  const asks =
    !!org.id &&
    !!org.slug &&
    !!projectId &&
    agentHasClonableSource(project?.metadata);
  const query = useQuery({
    queryKey: KEYS.mainSchemaV8(org.slug, projectId),
    queryFn: async () => {
      const isV8 = await fetchMainSchemaV8(org.slug, projectId);
      // The server just rewrote its cached answer: re-read the project.
      if (isV8 !== marked) {
        invalidateCollectionQueries(queryClient, org.id, "VIRTUAL_MCP");
      }
      return isV8;
    },
    enabled: asks,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
    retry: 2,
    refetchInterval: (q) =>
      q.state.status === "error" ? MAIN_SCHEMA_RETRY_MS : false,
  });
  return mainSchemaAnswer({
    asks,
    hasProject: !!project,
    data: query.data,
    // A re-poll of a failed read puts the query back to `pending` (no data
    // yet): the answer stays the failure's until a read succeeds, so the
    // editor and preview never flip back to loading every few seconds.
    isError: query.isError || query.errorUpdateCount > 0,
    marked,
  });
}

/**
 * Whether the server last found this project's main v8 (its marker). A hint
 * only, never a v8 answer: it tells a schema read that failed on a site last
 * found v8 (wait and retry) from any other one (v7, as on main). Used by the
 * sandbox decision, whose daemon decides once it answers.
 */
export function useLastFoundV8(
  virtualMcpId: string | null | undefined,
): boolean {
  return isBlocksV8Project(useVirtualMCP(virtualMcpId)?.metadata);
}
