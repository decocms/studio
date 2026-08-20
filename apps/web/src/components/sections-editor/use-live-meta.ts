import { type Query, useQuery } from "@tanstack/react-query";
import { exponentialBackoffWithJitter } from "@decocms/shared/std";
import { KEYS } from "@/lib/query-keys";
import { decoRepoPath } from "./deco-repo-path";
import { readCommittedJson } from "./read-committed-file";
import { useFastPreview } from "@/hooks/use-fast-preview";
import { usePackagePath } from "./use-package-path";
import type { LiveMeta } from "./resolve-schema";

interface UseLiveMetaParams {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
  previewUrl?: string | null;
}

/** Where to look for the CMS schema, in priority order. */
export type MetaSource =
  /** Sandbox dev server's `/live/_meta` (branch, live). */
  | { kind: "live"; baseUrl: string }
  /** Committed `.deco/meta.gen.json` snapshot — branch-accurate. */
  | { kind: "committed" }
  /** Linked production site's `/live/_meta` — a live deco runtime that serves
   *  the same route, so Fresh/Deno sites (which never persist meta to the FS)
   *  still get a schema before the sandbox dev server is up. */
  | { kind: "production"; baseUrl: string };

/**
 * Ordered schema sources. Pure so the priority is unit-tested without mocks.
 *
 * The committed snapshot always beats production: it reflects THIS branch's
 * schema, whereas production reflects whatever is deployed. Production is the
 * last resort — it only matters for sites with no committed `meta.gen.json`
 * (e.g. Fresh/Deco sites), unblocking the CMS before the runtime boots.
 *
 * Sandbox-less Fast Preview drops both sandbox-backed sources: there is no dev
 * server, and no daemon to read the working tree through, so production is the
 * only source that can answer.
 */
export function metaSourceOrder(input: {
  fetchEnabled: boolean;
  previewUrl: string | null | undefined;
  productionUrl: string | null;
  fastPreviewActive: boolean;
}): MetaSource[] {
  const sources: MetaSource[] = [];
  if (!input.fastPreviewActive) {
    if (input.fetchEnabled && input.previewUrl) {
      sources.push({ kind: "live", baseUrl: input.previewUrl });
    }
    sources.push({ kind: "committed" });
  }
  if (input.productionUrl) {
    sources.push({ kind: "production", baseUrl: input.productionUrl });
  }
  return sources;
}

export function useLiveMeta(
  params: UseLiveMetaParams | null,
  options?: {
    fetchEnabled?: boolean;
    refetchInterval?:
      | number
      | false
      | ((query: Query<LiveMeta>) => number | false | undefined);
  },
) {
  const fetchEnabled = options?.fetchEnabled ?? true;
  const previewUrl = params?.previewUrl;
  // Committed snapshot lives under the project's package path
  // (`metadata.runtime.path`) when the project isn't at the repo root; the live
  // `/live/_meta` route already resolves relative to the dev-server cwd.
  const packagePath = usePackagePath(params?.virtualMcpId);
  const { previewServerUrl: productionUrl, active: fastPreviewActive } =
    useFastPreview(params?.virtualMcpId);
  return useQuery({
    // productionUrl is appended so a settings edit re-fetches; invalidators key
    // on the (org, vm, branch) prefix, which still matches (variadic key).
    queryKey: params
      ? KEYS.liveMeta(
          params.orgSlug,
          params.virtualMcpId,
          params.branch,
          previewUrl ?? "",
          productionUrl ?? "",
        )
      : KEYS.liveMeta(""),
    queryFn: async () => {
      const fetchMeta = async (baseUrl: string): Promise<LiveMeta | null> => {
        const url = new URL("/live/_meta", baseUrl).href;
        const res = await fetch(url, { cache: "no-store" }).catch(() => null);
        if (!res?.ok) return null;
        // A repo that doesn't use the deco framework for sites still answers
        // this route: a plain Vite/SPA dev server hands back `index.html` with
        // a 200. `res.json()` on that throws a SyntaxError that escapes the
        // whole queryFn — skipping the remaining sources and surfacing an
        // untagged error the Preview gates can only read as "transient". Treat
        // an unparseable 200 as no answer instead, same as `parseDecofileBody`.
        try {
          return (await res.json()) as LiveMeta;
        } catch {
          return null;
        }
      };
      const readCommitted = () =>
        readCommittedJson<LiveMeta>(
          params!,
          decoRepoPath(packagePath, ".deco/meta.gen.json"),
        );

      // Walk the sources in priority order; first hit wins. Falling all the way
      // through means neither a live/production runtime nor a committed snapshot
      // is reachable yet — surface 502 so the query waits for the sandbox
      // lifecycle to re-invalidate (see sandbox-events-context) instead of
      // hammering a known-down endpoint.
      const sources = metaSourceOrder({
        fetchEnabled,
        previewUrl,
        productionUrl,
        fastPreviewActive,
      });
      for (const source of sources) {
        if (source.kind === "committed") {
          const committed = await readCommitted();
          if (committed.kind === "data") return committed.data;
          continue;
        }
        const meta = await fetchMeta(source.baseUrl);
        if (meta) return meta;
      }
      const err = new Error(
        "live meta unavailable (dev server down, no committed snapshot, no production fallback)",
      );
      (err as { status?: number }).status = 502;
      throw err;
    },
    enabled: !!params,
    refetchInterval: options?.refetchInterval,
    refetchIntervalInBackground: false,
    staleTime: 300_000,
    // 502 = nothing reachable yet. The sandbox lifecycle re-invalidates this
    // query when the dev server comes up (see sandbox-events-context), so
    // retrying just hammers a known-down endpoint. Sandbox-less Fast Preview
    // has no lifecycle event coming — a transient failure of the production
    // /live/_meta fetch would stick as a terminal error card, so bounded
    // retries ARE the recovery there.
    retry: (failureCount, error) =>
      fastPreviewActive
        ? failureCount < 3
        : (error as { status?: number }).status !== 502 && failureCount < 3,
    retryDelay: (attempt) =>
      exponentialBackoffWithJitter(5000, 1000, attempt, 2, 0),
  });
}
