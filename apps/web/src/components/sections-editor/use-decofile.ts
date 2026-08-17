import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSandboxLifecycle } from "@/components/sandbox/hooks/sandbox-lifecycle-context";
import { useVirtualMCP } from "@/sdk";
import { exponentialBackoffWithJitter } from "@decocms/shared/std";
import { KEYS } from "@/lib/query-keys";
import { decoRepoPath } from "./deco-repo-path";
import { fetchDecofile } from "./decofile-api";
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
  const vmcp = useVirtualMCP(params?.virtualMcpId);
  const packagePath = vmcp?.metadata?.runtime?.path ?? null;
  // Sandbox-less mode: the decofile API merges `.deco/blocks/*.json` at the
  // branch head on GitHub — no dev server, no working tree. The read also
  // seeds KEYS.decofileDraft ({version, token}) so the preview can build its
  // `?__draft=` pointer before any save happens.
  const cmsModeActive = useSandboxLifecycle().cmsModeActive;
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: KEYS.decofile(key),
    queryFn: async () => {
      if (cmsModeActive) {
        return fetchDecofile(queryClient, params!);
      }
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
    // 502 = preview unreachable / nothing available yet. Retrying just hammers
    // a known-down endpoint; sandbox-events-context re-invalidates this query
    // on first daemon contact (and again when the dev server reports
    // `running`), so the recovery is event-driven. The first-contact trigger is
    // load-bearing for Fast Preview: it renders off the daemon alone, so
    // waiting for `running` would strand it behind the install it skips.
    //
    // Sandbox-less Fast Preview inverts the rule: there is no lifecycle event
    // coming, and the API maps transient GitHub failures (rate limits,
    // upstream 5xx) to 502 — so a single hiccup would otherwise stick as a
    // terminal error card. Bounded retries with backoff ARE the recovery.
    retry: (failureCount, error) =>
      cmsModeActive
        ? failureCount < 3
        : (error as { status?: number }).status !== 502 && failureCount < 2,
    retryDelay: (attempt) =>
      exponentialBackoffWithJitter(5000, 1000, attempt, 2, 0),
  });
}
