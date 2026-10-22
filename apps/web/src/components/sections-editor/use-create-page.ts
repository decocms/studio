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

/** Where a Blocks v8 site's empty page is typed from (see `emptyPageBlock`). */
export interface NewPageSchema {
  /** The site's schema, when loaded. */
  meta?: LiveMeta | null;
  /** Reads the schema when `meta` hasn't loaded yet. */
  loadMeta?: () => Promise<LiveMeta | null | undefined>;
}

/**
 * The block an empty new page is saved as. A Blocks v8 site (`schema` given)
 * types it from its schema, read now when it hasn't loaded yet, and never
 * guesses. Any other site gets v7's page and SEO section without waiting for
 * a schema, as before.
 */
export async function emptyPageBlock(
  name: string,
  path: string,
  schema?: NewPageSchema,
): Promise<Record<string, unknown>> {
  if (!schema) return createEmptyPageBlock(name, path);
  return createEmptyPageBlock(
    name,
    path,
    await schemaForNewPage(schema.meta, schema.loadMeta),
  );
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
      schema,
    }: {
      name: string;
      path: string;
      /**
       * Source page block to clone. When provided, its content is copied
       * and only name/path are overridden; otherwise an empty page is built.
       */
      template?: Record<string, unknown> | null;
      /**
       * A Blocks v8 site's schema: an empty page takes its page and SEO
       * types from it. Absent on any other site (v7's page, as before).
       */
      schema?: NewPageSchema;
    }): Promise<CreatePageResult> => {
      if (!params?.virtualMcpId || !params.branch) {
        throw new Error("Sandbox not ready");
      }
      const blockKey = generatePageBlockKey(name);
      const data = template
        ? { ...template, name, path }
        : await emptyPageBlock(name, path, schema);
      await saveBlock.mutateAsync({ blockKey, data });
      return { key: blockKey, name, path };
    },
  });
}
