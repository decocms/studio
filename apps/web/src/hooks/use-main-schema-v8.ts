/**
 * Main's schema answer for a project: `isV8Schema` on main's schema, run
 * here on the schema read over the content protocol (`schema.get` on the
 * project's `/api/:org/decofile/:id/:branch/rpc`, the endpoint the v8 editor
 * reads its form schema from anyway). That route answers any site: a v7 one
 * gets `schema: null` from the server's own cached answer (an ETag-cached
 * head read and a per-commit answer), so v7 costs one cheap read. Read once
 * per project per session, again only when the server says main changed
 * since (`main-schema-changed.ts`).
 *
 * The read keeps main's schema and its version, not just the answer: on a
 * v8 site it is the form schema the editor opens with (`schema.get` on that
 * route reads main whatever the branch), so the GitHub probe and the first
 * content poll reuse it (`mainSchemaRead` in `main-schema-changed.ts`) instead of downloading it again.
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
import {
  HOSTED_DELIVERY_UNCONFIGURED,
  isBlocksV8Project,
  isV8Schema,
} from "@decocms/shared/blocks-major";
import { agentHasClonableSource } from "@/lib/agent-capabilities";
import type { MainSchemaRead } from "@/hooks/main-schema-changed";
import { KEYS } from "@/lib/query-keys";
import { useProjectContext, useVirtualMCP } from "@/sdk";
import { invalidateCollectionQueries } from "@/sdk/hooks/use-collections";

export type MainSchemaAnswer = "v8" | "v7" | "loading" | "error";

/** How often a failed read of main's schema is retried. */
const MAIN_SCHEMA_RETRY_MS = 5_000;

/**
 * The branch in the content-protocol URL of a project-level read: `describe`
 * and `schema.get` always read main, whatever the branch says.
 */
const MAIN_SCHEMA_BRANCH = "main";

/** Studio's answers that settle main's answer without a schema. */
const ANSWER_BY_STATUS: Record<string, boolean> = {
  // No repository: no main, not a v8 site.
  "404 no_repository": false,
  // No CMS in the org's plan: the decofile routes' plan gate answers before
  // main's schema is read, so a v8 site there is deliberately treated as v7
  // by every caller (editor, preview, Localhost tunnel), as on main. Every
  // plan includes `cms` today; revisit this if a plan without it is added.
  "403 feature_not_in_plan": false,
  // These gates run only once main is v8.
  "409 site_not_owned": true,
  [`503 ${HOSTED_DELIVERY_UNCONFIGURED}`]: true,
};

/**
 * Main's schema and whether it is a Blocks v8 one: `schema.get` over the
 * project's content protocol, then `isV8Schema` on it. Throws when main
 * couldn't be read (retried), never a v7 answer the editor would act on.
 */
export async function fetchMainSchemaV8(
  orgSlug: string,
  virtualMcpId: string,
  doFetch: (input: string, init: RequestInit) => Promise<Response> = (
    input,
    init,
  ) => fetch(input, init),
): Promise<MainSchemaRead> {
  const res = await doFetch(
    `/api/${orgSlug}/decofile/${encodeURIComponent(virtualMcpId)}/${MAIN_SCHEMA_BRANCH}/rpc`,
    {
      method: "POST",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "schema.get" }),
    },
  );
  const body = (await res.json().catch(() => null)) as {
    code?: unknown;
    result?: { schema?: unknown; version?: unknown };
  } | null;
  if (!res.ok) {
    const settled = ANSWER_BY_STATUS[`${res.status} ${body?.code}`];
    if (settled !== undefined) {
      return { isV8: settled, schema: null, version: null };
    }
    throw new Error(`main's schema: HTTP ${res.status}`);
  }
  if (!body?.result || !("schema" in body.result)) {
    throw new Error("main's schema: unexpected answer");
  }
  const { schema, version } = body.result;
  return {
    isV8: isV8Schema(schema),
    schema: schema ?? null,
    version: typeof version === "string" ? version : null,
  };
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
      const read = await fetchMainSchemaV8(org.slug, projectId);
      // The server just rewrote its cached answer: re-read the project.
      if (read.isV8 !== marked) {
        invalidateCollectionQueries(queryClient, org.id, "VIRTUAL_MCP");
      }
      return read;
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
    data: query.data?.isV8,
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
 * sandbox decision, whose working tree decides once it answers.
 */
export function useLastFoundV8(
  virtualMcpId: string | null | undefined,
): boolean {
  return isBlocksV8Project(useVirtualMCP(virtualMcpId)?.metadata);
}
