import { nanoid } from "nanoid";

// GenericToolCaller for filesystem/bash tools not in DECO_BLOCKS_BINDING
export type GenericToolCaller = (
  toolName: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

export interface BlockInstance {
  id: string; // nanoid(8)
  blockType: string; // e.g. "ProductShelf" (matches block.name from BLOCKS_LIST)
  props: Record<string, unknown>;
  loaderBinding?: {
    // optional loader prop binding
    prop: string; // prop name this loader is bound to
    loaderName: string;
    loaderProps: Record<string, unknown>;
  };
}

export interface PageMetadata {
  description: string;
  createdAt: string;
  updatedAt: string;
}

export interface Page {
  id: string; // e.g. "page_abc12345"
  path: string; // URL path e.g. "/products"
  title: string;
  blocks: BlockInstance[];
  metadata: PageMetadata;
}

// Tombstone shape for deleted pages
interface PageTombstone {
  deleted: true;
  deletedAt: string;
  id: string;
  title: string;
}

/**
 * List all non-deleted pages from the .deco/pages/ directory.
 * Returns pages sorted by createdAt descending.
 */
export async function listPages(
  toolCaller: GenericToolCaller,
): Promise<Page[]> {
  try {
    const result = await toolCaller("list_directory", { path: ".deco/pages/" });

    // Handle both response shapes defensively
    let entries: Array<{ name: string }> = [];
    if (Array.isArray(result)) {
      entries = result as Array<{ name: string }>;
    } else if (
      result != null &&
      typeof result === "object" &&
      "entries" in result &&
      Array.isArray((result as { entries: unknown }).entries)
    ) {
      entries = (result as { entries: Array<{ name: string }> }).entries;
    }

    // Filter to .json files only
    const jsonEntries = entries.filter(
      (e) => typeof e.name === "string" && e.name.endsWith(".json"),
    );

    // Fetch each page, filter out tombstones and nulls
    const pages = await Promise.all(
      jsonEntries.map((e) => {
        const id = e.name.slice(0, -5); // remove .json
        return getPage(toolCaller, id);
      }),
    );

    const validPages = pages.filter((p): p is Page => p !== null);

    // Sort by createdAt descending
    return validPages.sort(
      (a, b) =>
        new Date(b.metadata.createdAt).getTime() -
        new Date(a.metadata.createdAt).getTime(),
    );
  } catch {
    return [];
  }
}

/**
 * Read a single page by ID. Returns null if not found or if tombstoned.
 */
export async function getPage(
  toolCaller: GenericToolCaller,
  id: string,
): Promise<Page | null> {
  try {
    const result = await toolCaller("read_file", {
      path: `.deco/pages/${id}.json`,
    });

    const content = (result as { content: string }).content;
    const parsed = JSON.parse(content) as Page | PageTombstone;

    if ("deleted" in parsed && parsed.deleted === true) {
      return null;
    }

    return parsed as Page;
  } catch {
    return null;
  }
}

/**
 * Create a new page and write it to .deco/pages/{id}.json.
 */
export async function createPage(
  toolCaller: GenericToolCaller,
  title: string,
  path: string,
): Promise<Page> {
  const id = "page_" + nanoid(8);
  const now = new Date().toISOString();

  const page: Page = {
    id,
    path,
    title,
    blocks: [],
    metadata: {
      description: "",
      createdAt: now,
      updatedAt: now,
    },
  };

  await toolCaller("write_file", {
    path: `.deco/pages/${id}.json`,
    content: JSON.stringify(page, null, 2),
  });

  return page;
}

/**
 * Write the full page JSON to the file (atomic full-document write).
 * Updates metadata.updatedAt automatically.
 */
export async function updatePage(
  toolCaller: GenericToolCaller,
  page: Page,
): Promise<void> {
  const updated: Page = {
    ...page,
    metadata: {
      ...page.metadata,
      updatedAt: new Date().toISOString(),
    },
  };

  await toolCaller("write_file", {
    path: `.deco/pages/${page.id}.json`,
    content: JSON.stringify(updated, null, 2),
  });
}

/**
 * Write a tombstone to the page file to mark it as deleted.
 */
export async function deletePage(
  toolCaller: GenericToolCaller,
  id: string,
  title: string,
): Promise<void> {
  const tombstone: PageTombstone = {
    deleted: true as const,
    deletedAt: new Date().toISOString(),
    id,
    title,
  };

  await toolCaller("write_file", {
    path: `.deco/pages/${id}.json`,
    content: JSON.stringify(tombstone, null, 2),
  });
}
