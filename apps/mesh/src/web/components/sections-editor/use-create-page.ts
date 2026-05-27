import { useMutation, useQueryClient } from "@tanstack/react-query";
import { KEYS } from "@/web/lib/query-keys";

interface UseCreatePageParams {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
}

export interface CreatePageResult {
  key: string;
  name: string;
  path: string;
}

export function useCreatePage({
  orgSlug,
  virtualMcpId,
  branch,
}: UseCreatePageParams) {
  const queryClient = useQueryClient();
  const cacheKey = `${orgSlug}/${virtualMcpId}/${branch}`;

  return useMutation({
    mutationFn: async ({
      name,
      path,
    }: {
      name: string;
      path: string;
    }): Promise<CreatePageResult> => {
      const blockKey = `pages-${encodeURIComponent(name)}-${Math.floor(Math.random() * 1e6)}`;
      const newBlock = {
        name,
        path,
        sections: [],
        seo: { __resolveType: "website/sections/Seo/SeoV2.tsx" },
        __resolveType: "website/pages/Page.tsx",
      };
      const res = await fetch(
        `/api/${orgSlug}/sandbox/${encodeURIComponent(virtualMcpId)}/${encodeURIComponent(branch)}/write`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            path: `.deco/blocks/${blockKey}.json`,
            content: JSON.stringify(newBlock, null, 2),
          }),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          (body as { error?: string }).error ?? `Write failed (${res.status})`,
        );
      }
      return { key: blockKey, name, path };
    },
    onSuccess: (result) => {
      const queryKey = KEYS.decofile(cacheKey);
      queryClient.setQueryData(
        queryKey,
        (current: Record<string, unknown> | undefined) => {
          if (!current) return current;
          return {
            ...current,
            [result.key]: {
              name: result.name,
              path: result.path,
              sections: [],
              seo: { __resolveType: "website/sections/Seo/SeoV2.tsx" },
              __resolveType: "website/pages/Page.tsx",
            },
          };
        },
      );
    },
  });
}
