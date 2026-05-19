import { useMutation, useQueryClient } from "@tanstack/react-query";
import { KEYS } from "@/web/lib/query-keys";

interface UseSaveBlockParams {
  previewUrl: string;
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
}

export function useSaveBlock({
  previewUrl,
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
      const path = `.deco/blocks/${blockKey}.json`;
      const content = JSON.stringify(data, null, 2);
      const params = new URLSearchParams({ virtualMcpId, branch });
      const res = await fetch(
        `/api/${orgSlug}/vm-file/write?${params.toString()}`,
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
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: KEYS.decofile(previewUrl),
      });
    },
  });
}
