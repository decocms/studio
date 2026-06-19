import { useQuery } from "@tanstack/react-query";
import { KEYS } from "@/web/lib/query-keys";
import { buildPreviewFetchUrl } from "./preview-fetch-url";

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
    ? `${params.orgSlug}/${params.virtualMcpId}/${params.branch}/${params.previewUrl ?? ""}`
    : "";
  const fetchEnabled = options?.fetchEnabled ?? true;
  return useQuery({
    queryKey: KEYS.decofile(key),
    queryFn: async () => {
      const res = await fetch(
        buildPreviewFetchUrl({ ...params!, path: "/.decofile" }),
      );
      if (!res.ok) {
        const err = new Error(`Failed to fetch decofile: ${res.status}`);
        (err as { status?: number }).status = res.status;
        throw err;
      }
      return (await res.json()) as Record<string, unknown>;
    },
    enabled: !!params && fetchEnabled,
    staleTime: 30_000,
    // 502 = preview unreachable (sandbox starting or down). The SSE lifecycle
    // re-enables this query when the preview is back, so retrying just hammers
    // a known-down endpoint and spams 5xx logs.
    retry: (failureCount, error) =>
      (error as { status?: number }).status !== 502 && failureCount < 2,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 5000),
  });
}
