import { useQuery } from "@tanstack/react-query";
import { KEYS } from "@/lib/query-keys";
import { useProjectContext } from "@/sdk";
import { useStudioTools } from "@/lib/studio-tools";

/**
 * Whether a PR's deploy preview is reachable right now.
 *
 * The probe runs on the server (`TASK_BOARD_PREVIEW_PROBE`) because the browser
 * cannot read the status of a cross-origin request: `fetch` is blocked by CORS
 * and `no-cors` reports 0 for a 200 and a 500 alike.
 *
 * Not cached: `gcTime: 0` and `staleTime: 0` so re-opening the card re-probes.
 * A preview that was down while it built must not stay marked unavailable once
 * it is up, which is exactly what a cached answer would do.
 */
export function usePreviewProbe(url: string | null | undefined) {
  const { locator } = useProjectContext();
  const studio = useStudioTools();

  return useQuery({
    queryKey: KEYS.previewProbe(locator, url ?? ""),
    enabled: !!url,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    queryFn: () => studio.call("TASK_BOARD_PREVIEW_PROBE", { url: url! }),
  });
}
