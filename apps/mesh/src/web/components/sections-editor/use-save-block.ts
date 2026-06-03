import { useEffect, useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { decoBlockFilePath } from "./deco-block-key";
import { KEYS } from "@/web/lib/query-keys";
import { decoBlockFilePath } from "./deco-block-key";

/** Debounce window for form-driven block autosaves (ms). */
export const AUTOSAVE_DELAY = 700;

interface UseSaveBlockParams {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
}

export function useSaveBlock({
  orgSlug,
  virtualMcpId,
  branch,
}: UseSaveBlockParams) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      blockKey,
      data,
    }: {
      blockKey: string;
      data: unknown;
    }) => {
      const path = decoBlockFilePath(blockKey);
      const content = JSON.stringify(data, null, 2);
      const res = await fetch(
        `/api/${orgSlug}/sandbox/${encodeURIComponent(virtualMcpId)}/${encodeURIComponent(branch)}/write`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path, content }),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          (body as { error?: string }).error ?? `Write failed (${res.status})`,
        );
      }
      return res.json();
    },
    onMutate: async ({ blockKey, data }) => {
      const cacheKey = `${orgSlug}/${virtualMcpId}/${branch}`;
      const queryKey = KEYS.decofile(cacheKey);
      await queryClient.cancelQueries({ queryKey });
      const previous =
        queryClient.getQueryData<Record<string, unknown>>(queryKey);
      queryClient.setQueryData(
        queryKey,
        (current: Record<string, unknown> | undefined) => ({
          ...(current ?? {}),
          [blockKey]: data,
        }),
      );
      return { previous, queryKey };
    },
    onError: (_error, _variables, context) => {
      if (context?.queryKey) {
        queryClient.setQueryData(context.queryKey, context.previous);
      }
    },
    onSuccess: (_result, { blockKey, data }) => {
      const cacheKey = `${orgSlug}/${virtualMcpId}/${branch}`;
      queryClient.setQueryData(
        KEYS.decofile(cacheKey),
        (current: Record<string, unknown> | undefined) => ({
          ...(current ?? {}),
          [blockKey]: data,
        }),
      );
    },
  });
}

/**
 * The payload for a debounced save: either a ready object, or a builder
 * resolved at fire time. Pass a builder when the block is also written by
 * another debounced path (e.g. a page's name/path edits vs. its SEO edits) so
 * the persisted value is a read-modify-write against the freshest block data
 * instead of a stale keystroke-time snapshot — otherwise the later-firing save
 * clobbers the other path's concurrent edit.
 */
type SaveData =
  | Record<string, unknown>
  | (() => Record<string, unknown> | null);

/**
 * Wraps {@link useSaveBlock} with the standard debounced-autosave loop shared by
 * every form-driven block editor (section forms, the SEO editor, the SEO
 * sheets). Call `save(blockKey, data)` on each change; the latest payload is
 * persisted once edits settle for {@link AUTOSAVE_DELAY}ms, with a toast on
 * failure. `data` may be a builder (see {@link SaveData}) that returns null to
 * abort the save.
 */
export function useDebouncedSaveBlock(
  params: UseSaveBlockParams,
  opts?: { onSaved?: () => void },
) {
  const saveBlock = useSaveBlock(params);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestRef = useRef<{ blockKey: string; data: SaveData } | null>(null);

  const runPendingSave = () => {
    const pending = latestRef.current;
    if (!pending) return;
    const resolved =
      typeof pending.data === "function" ? pending.data() : pending.data;
    if (!resolved) return;
    latestRef.current = null;
    saveBlock.mutate(
      { blockKey: pending.blockKey, data: resolved },
      {
        onSuccess: () => opts?.onSaved?.(),
        onError: (err) => toast.error(`Save failed: ${err.message}`),
      },
    );
  };

  const flush = () => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    runPendingSave();
  };

  // Cancel a pending debounced save on unmount so it can't fire against a torn
  // -down editor after navigation. Call `flush()` explicitly when closing a sheet
  // or leaving an editor so edits inside the debounce window still persist.
  // oxlint-disable-next-line ban-use-effect/ban-use-effect — timer lifecycle cleanup on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const save = (blockKey: string, data: SaveData) => {
    latestRef.current = { blockKey, data };
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      runPendingSave();
    }, AUTOSAVE_DELAY);
  };

  return { save, flush, isPending: saveBlock.isPending };
}
