import { useIsMutating } from "@tanstack/react-query";
import { useMinimumDuration } from "@/hooks/use-minimum-duration";
import { decofileWriteMutationKey } from "./decofile-api";

/** Floor for how long the autosave indicator stays up, so a fast write can't flash. */
const AUTOSAVE_INDICATOR_MIN_MS = 500;

/** True while a block write is in flight, held for {@link AUTOSAVE_INDICATOR_MIN_MS}. */
export function useDecofileWriting(
  orgSlug: string,
  virtualMcpId: string,
  branch: string,
): boolean {
  const writing =
    useIsMutating({
      mutationKey: decofileWriteMutationKey(orgSlug, virtualMcpId, branch),
    }) > 0;
  return useMinimumDuration(writing, AUTOSAVE_INDICATOR_MIN_MS);
}
