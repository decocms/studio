import { useQuery } from "@tanstack/react-query";
import { useVirtualMCP } from "@/sdk";
import { exponentialBackoffWithJitter } from "@decocms/shared/std";
import { KEYS } from "@/lib/query-keys";
import { decoRepoPath } from "./deco-repo-path";
import { buildDecofileFetchUrl } from "./preview-fetch-url";
import { readCommittedJson } from "./read-committed-file";

interface UseDecofileParams {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
  previewUrl?: string | null;
}

export function useDecofile(
  params: UseDecofileParams | null,
  options?: { fetchEnabled?: boolean },
) {
  const key = params
    ? `${params.orgSlug}/${params.virtualMcpId}/${params.branch}`
    : "";
  // `fetchEnabled` means the dev server is up, so the live `/.decofile` route is
  // worth hitting. When it's down we read `.deco/blocks.gen.json` straight from
  // the working tree — and if that artifact is absent (it's commonly gitignored)
  // the daemon regenerates it from the `.deco/blocks/*.json` sources, so the CMS
  // is readable as soon as the FS is up, before the dev server boots. Single
  // source of truth for KEYS.decofile, so optimistic block writes (which persist
  // to the FS) operate on a full base and the CMS stays editable even if the
  // preview never comes up.
  //
  // Unlike `useLiveMeta`, there is deliberately NO production `/.decofile`
  // fallback: content must stay branch-accurate (the FS/daemon path reflects
  // THIS branch), whereas production would serve deployed content and desync
  // optimistic edits. `useLiveMeta` can safely fall back to production because
  // the schema is branch-independent — see its `metaSourceOrder`.
  const fetchEnabled = options?.fetchEnabled ?? true;
  // Committed snapshot lives under the project's package path
  // (`metadata.runtime.path`) when the project isn't at the repo root — the
  // daemon reads resolve against the repo root, so prefix it. The live
  // `/.decofile` route already resolves relative to the dev-server cwd.
  const packagePath =
    useVirtualMCP(params?.virtualMcpId)?.metadata?.runtime?.path ?? null;
  return useQuery({
    queryKey: KEYS.decofile(key),
    queryFn: async () => {
      const readCommitted = () =>
        readCommittedJson<Record<string, unknown>>(
          params!,
          decoRepoPath(packagePath, ".deco/blocks.gen.json"),
        );
      if (fetchEnabled) {
        const res = await fetch(buildDecofileFetchUrl(params!), {
          cache: "no-store",
        }).catch(() => null);
        if (res?.ok) return (await res.json()) as Record<string, unknown>;
        // Dev server reported ready but the route failed (e.g. dev script
        // crashed): fall back to the committed snapshot so editing still works.
        const committed = await readCommitted();
        if (committed) return committed;
        const err = new Error(
          `Failed to fetch decofile: ${res?.status ?? "network error"}`,
        );
        (err as { status?: number }).status = res?.status ?? 502;
        throw err;
      }
      const committed = await readCommitted();
      if (committed) return committed;
      const err = new Error(
        "decofile unavailable (preview down, no committed snapshot)",
      );
      (err as { status?: number }).status = 502;
      throw err;
    },
    enabled: !!params,
    staleTime: 30_000,
    // 502 = preview unreachable / nothing available yet. The sandbox lifecycle
    // re-invalidates this query when the dev server comes up (see
    // sandbox-events-context), so retrying just hammers a known-down endpoint.
    retry: (failureCount, error) =>
      (error as { status?: number }).status !== 502 && failureCount < 2,
    retryDelay: (attempt) =>
      exponentialBackoffWithJitter(5000, 1000, attempt, 2, 0),
  });
}
