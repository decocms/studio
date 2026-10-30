import { type Query, useQuery, useQueryClient } from "@tanstack/react-query";
import { exponentialBackoffWithJitter } from "@decocms/shared/std";
import { KEYS } from "@/lib/query-keys";
import { decoRepoPath } from "./deco-repo-path";
import {
  readCommittedJson,
  readCommittedMetaViaGit,
} from "./read-committed-file";
import { useSessionRuntime } from "@/hooks/use-session-runtime";
import { useLocalPreviewUrl } from "@/hooks/use-local-preview-url";
import { usePackagePath } from "./use-package-path";
import type { LiveMeta } from "./resolve-schema";
import { useContentBackend } from "./use-content-backend";
import { useDecofileCacheKey } from "./use-decofile";
import {
  pollProtocolContent,
  protocolMetaQueryKey,
  protocolUnavailableError,
} from "./content-protocol-api";

interface UseLiveMetaParams {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
  /** The session reading; `null` only for a thread-less surface. */
  threadId: string | null;
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
 * Sandbox-less Fast Preview reads `committed` from the branch via the GitHub
 * API (`readCommittedMetaViaGit`), not a dev server/daemon.
 */
export function metaSourceOrder(input: {
  fetchEnabled: boolean;
  previewUrl: string | null | undefined;
  productionUrl: string | null;
  fastPreviewActive: boolean;
}): MetaSource[] {
  const sources: MetaSource[] = [];
  if (input.fastPreviewActive) {
    sources.push({ kind: "committed" });
  } else {
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

/**
 * How often Local mode re-reads the tunnel's schema. The tunnel is the user's
 * own dev server, which regenerates the schema as they edit section props, and
 * nothing pushes that change to Studio. Visible tabs only.
 */
const LOCAL_META_POLL_MS = 5_000;

/**
 * What each site's runtime turned out to do with `If-None-Match`, learned by
 * asking. A failed cross-origin request reads exactly like a dev server that
 * is down, so the two are told apart the only way the browser allows: ask
 * again plainly, and see whether THAT works.
 *
 * Remembering the answer is what keeps the cost at one request. Without it a
 * runtime that refuses the header pays a rejected preflight on every single
 * read, and — worse, because it is the common case — every read taken while
 * the dev server restarts sends two failing requests instead of one.
 *
 * Keyed by base URL, which is the pod: a different sandbox re-learns.
 */
export type ConditionalSupport = Map<string, "ok" | "refused">;

const conditionalSupport: ConditionalSupport = new Map();

/**
 * A running site's `/live/_meta`, or `null` when it can't answer. With the
 * schema already held, asks with its `etag`; a deco runtime then answers 304
 * instead of the whole schema, and the held one is returned. A dev server on
 * a `@decocms/tanstack` that predates its admin preflight rejects that request
 * (CORS); the held schema is kept then too, as before polling.
 */
export async function fetchLiveMeta(
  baseUrl: string,
  previous?: LiveMeta,
  /** What this browser has learned about each runtime; see above. */
  support: ConditionalSupport = conditionalSupport,
): Promise<LiveMeta | null> {
  const url = new URL("/live/_meta", baseUrl).href;
  const known = support.get(baseUrl);
  const etag = known === "refused" ? undefined : previous?.etag;
  const first = await fetch(url, {
    cache: "no-store",
    headers: etag ? { "If-None-Match": etag } : {},
  }).catch(() => null);
  // Only while it is still unknown. Once a conditional request has worked
  // against this runtime, a failure is the server being unreachable and
  // asking again plainly just doubles the cost of a dev server that is down.
  const retryPlainly = !first && !!etag && known === undefined;
  const res = retryPlainly
    ? await fetch(url, { cache: "no-store", headers: {} }).catch(() => null)
    : first;
  if (etag) {
    // The plain request answering where the conditional one could not is the
    // only evidence that the HEADER, not the server, was the problem.
    if (retryPlainly && res) support.set(baseUrl, "refused");
    else if (first) support.set(baseUrl, "ok");
  }
  if (previous && (!res || res.status === 304)) return previous;
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
}

/**
 * Cache key for one meta read. The `(orgSlug, virtualMcpId, branch)` head is
 * the invalidation scope — `KEYS.liveMeta(org, vmid, branch)` must stay a
 * prefix of it, since that is how the sandbox lifecycle swaps the CMS off the
 * committed/production schema once the dev server is up. The URL tail is what
 * makes a settings edit re-fetch.
 */
export function liveMetaQueryKey(params: {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
  previewUrl?: string | null;
  productionUrl?: string | null;
}) {
  return KEYS.liveMeta(
    params.orgSlug,
    params.virtualMcpId,
    params.branch,
    params.previewUrl ?? "",
    params.productionUrl ?? "",
  );
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
  /**
   * Local mode: the pasted tunnel is a live dev server, so read `/live/_meta`
   * from it directly (fetch forced on) and skip every committed fallback — both
   * the sandbox `/read` proxy and the git route go through gated/absent surfaces
   * a tunnel-only project doesn't have.
   */
  // A saved Local tunnel waits for main's answer (v7 uses it, v8 never).
  const { url: localPreviewUrl, undecided: tunnelUndecided } =
    useLocalPreviewUrl(params?.virtualMcpId);
  const localOverride = !!localPreviewUrl;
  const fetchEnabled = localOverride || (options?.fetchEnabled ?? true);
  const previewUrl = localPreviewUrl ?? params?.previewUrl;
  // Committed snapshot lives under the project's package path
  // (`metadata.runtime.path`) when the project isn't at the repo root; the live
  // `/live/_meta` route already resolves relative to the dev-server cwd.
  const packagePath = usePackagePath(params?.virtualMcpId);
  const { previewServerUrl: productionUrl, runtime } = useSessionRuntime(
    params?.virtualMcpId,
  );
  const fastPreviewActive = !localOverride && runtime === "cms";
  // Next-major Blocks sites read the committed schema over the content
  // protocol: never from the running site.
  const backend = useContentBackend(params?.virtualMcpId, params?.branch);
  const protocol = backend.kind === "protocol" ? backend : null;
  const queryClient = useQueryClient();
  const decofileKey = useDecofileCacheKey(params ?? null);
  const queryKey = params
    ? protocol
      ? protocolMetaQueryKey(params, protocol)
      : liveMetaQueryKey({ ...params, previewUrl, productionUrl })
    : KEYS.liveMeta("");
  return useQuery({
    queryKey,
    queryFn: async () => {
      if (protocol) {
        // The same batched poll as the decofile's: one request for both.
        const { meta } = await pollProtocolContent(
          queryClient,
          protocol,
          params!,
          decofileKey,
        );
        if (meta instanceof Error) throw meta;
        return meta;
      }
      if (backend.kind === "unavailable") {
        throw protocolUnavailableError("live meta");
      }
      const readCommitted = () =>
        fastPreviewActive
          ? readCommittedMetaViaGit<LiveMeta>(params!)
          : readCommittedJson<LiveMeta>(
              params!,
              decoRepoPath(packagePath, ".deco/meta.gen.json"),
            );

      // Walk the sources in priority order; first hit wins. Falling all the way
      // through means neither a live/production runtime nor a committed snapshot
      // is reachable yet — surface 502 so the query waits for the sandbox
      // lifecycle to re-invalidate (see sandbox-events-context) instead of
      // hammering a known-down endpoint.
      const sources: MetaSource[] =
        localOverride && previewUrl
          ? [{ kind: "live", baseUrl: previewUrl }]
          : metaSourceOrder({
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
        // Revalidate what we hold whenever the runtime gave us an etag to
        // revalidate WITH. Two reasons, both measured against a sandbox dev
        // server: the schema is ~1 MB and a 304 is ~0, and a dev server that
        // misses a beat (a restart, a paused VM waking) must not drop the CMS
        // back onto the committed snapshot, which is a build behind — an app
        // installed into the working tree is in one and not the other, so the
        // editor flips between "no editable schema" and "appears after the
        // build" every couple of seconds. An etag is also what says the
        // runtime is new enough to accept the conditional request at all.
        const held = queryClient.getQueryData<LiveMeta>(queryKey);
        const meta = await fetchLiveMeta(
          source.baseUrl,
          localOverride || held?.etag ? held : undefined,
        );
        if (meta) return meta;
      }
      const err = new Error(
        "live meta unavailable (dev server down, no committed snapshot, no production fallback)",
      );
      (err as { status?: number }).status = 502;
      throw err;
    },
    enabled: !!params && backend.kind !== "pending" && !tunnelUndecided,
    // On the protocol, the decofile's poll refreshes the schema too.
    refetchInterval: protocol
      ? false
      : localOverride
        ? LOCAL_META_POLL_MS
        : options?.refetchInterval,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: protocol ? false : undefined,
    staleTime: protocol ? protocol.describe.pollIntervalMs : 300_000,
    // 502 = nothing reachable yet. The sandbox lifecycle re-invalidates this
    // query when the dev server comes up (see sandbox-events-context), so
    // retrying just hammers a known-down endpoint. Sandbox-less Fast Preview
    // has no lifecycle event coming — a transient failure of the production
    // /live/_meta fetch would stick as a terminal error card, so bounded
    // retries ARE the recovery there.
    // Local mode, like sandbox-less Fast Preview, has no lifecycle event to re-invalidate a 502, so bounded retries are its recovery.
    retry: (failureCount, error) =>
      protocol || fastPreviewActive || localOverride
        ? failureCount < 3
        : (error as { status?: number }).status !== 502 && failureCount < 3,
    retryDelay: (attempt) =>
      exponentialBackoffWithJitter(5000, 1000, attempt, 2, 0),
  });
}
