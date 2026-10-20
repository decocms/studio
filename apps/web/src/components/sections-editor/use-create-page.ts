import { useMutation } from "@tanstack/react-query";
import {
  createEmptyPageBlock,
  generatePageBlockKey,
} from "./page-block-template";
import type { LiveMeta } from "./resolve-schema";
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

/** The site's schema couldn't be read, so an empty page can't be typed yet. */
export class PageSchemaNotReadyError extends Error {
  constructor() {
    super("The site's schema isn't loaded yet");
    this.name = "PageSchemaNotReadyError";
  }
}

/**
 * The schema an empty page is typed from: the one already loaded, else read
 * now. Never guessed — a next-major site must not get the v7 page names
 * because its schema hadn't arrived yet.
 */
export async function schemaForNewPage(
  meta: LiveMeta | null | undefined,
  loadMeta?: () => Promise<LiveMeta | null | undefined>,
): Promise<LiveMeta> {
  if (meta) return meta;
  const loaded = await loadMeta?.().catch(() => null);
  if (!loaded) throw new PageSchemaNotReadyError();
  return loaded;
}

export function useCreatePage(params: UseCreatePageParams | null) {
  const saveBlock = useSaveBlock(
    params ?? { orgSlug: "", virtualMcpId: "", branch: "" },
  );

  return useMutation({
    mutationFn: async ({
      name,
      path,
      template,
      meta,
      loadMeta,
    }: {
      name: string;
      path: string;
      /**
       * Source page block to clone. When provided, its content is copied
       * and only name/path are overridden; otherwise an empty page is built.
       */
      template?: Record<string, unknown> | null;
      /** The site's schema: an empty page takes its page and SEO types from it. */
      meta?: LiveMeta | null;
      /** Reads the schema when `meta` hasn't loaded yet. */
      loadMeta?: () => Promise<LiveMeta | null | undefined>;
    }): Promise<CreatePageResult> => {
      if (!params?.virtualMcpId || !params.branch) {
        throw new Error("Sandbox not ready");
      }
      const blockKey = generatePageBlockKey(name);
      const data = template
        ? { ...template, name, path }
        : createEmptyPageBlock(
            name,
            path,
            await schemaForNewPage(meta, loadMeta),
          );
      await saveBlock.mutateAsync({ blockKey, data });
      return { key: blockKey, name, path };
    },
  });
}
