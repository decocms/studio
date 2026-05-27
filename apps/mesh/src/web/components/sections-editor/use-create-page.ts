import { useMutation } from "@tanstack/react-query";
import {
  createEmptyPageBlock,
  generatePageBlockKey,
} from "./page-block-template";
import { useSaveBlock } from "./use-save-block";

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

export function useCreatePage(params: UseCreatePageParams | null) {
  const saveBlock = useSaveBlock(
    params ?? { orgSlug: "", virtualMcpId: "", branch: "" },
  );

  return useMutation({
    mutationFn: async ({
      name,
      path,
    }: {
      name: string;
      path: string;
    }): Promise<CreatePageResult> => {
      if (!params?.virtualMcpId || !params.branch) {
        throw new Error("Sandbox not ready");
      }
      const blockKey = generatePageBlockKey(name);
      const data = createEmptyPageBlock(name, path);
      await saveBlock.mutateAsync({ blockKey, data });
      return { key: blockKey, name, path };
    },
  });
}
