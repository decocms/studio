/**
 * Block Utilities
 *
 * Utilities for working with deco blocks:
 * - Path <-> ID conversion
 * - Metadata inference
 * - Block type detection
 */

const DECO_FOLDER = ".deco";
const BLOCKS_FOLDER = `/${DECO_FOLDER}/blocks`;

/**
 * Block type definition
 */
export type BlockType =
  | "pages"
  | "sections"
  | "loaders"
  | "actions"
  | "apps"
  | "flags"
  | "handlers"
  | "matchers"
  | "workflows"
  | "redirects";

/**
 * Base block interface
 */
export interface Block {
  __resolveType: string;
  [key: string]: unknown;
}

/**
 * Block metadata inferred from content
 */
export interface BlockMetadata {
  blockType: BlockType;
  __resolveType: string;
  name?: string;
  path?: string;
}

/**
 * DECOFILE utilities for path and block management
 */
export const DECOFILE = {
  paths: {
    blocks: {
      /**
       * Convert a block ID to its file path.
       *
       * @example
       * DECOFILE.paths.blocks.fromId('pages-home-abc123')
       * // Returns: '/.deco/blocks/pages-home-abc123.json'
       */
      fromId: (blockId: string): string => {
        return `${BLOCKS_FOLDER}/${encodeURIComponent(blockId)}.json`;
      },

      /**
       * Convert a file path to its block ID.
       *
       * @example
       * DECOFILE.paths.blocks.toId('/.deco/blocks/pages-home-abc123.json')
       * // Returns: 'pages-home-abc123'
       */
      toId: (path: string): string | null => {
        if (!path.startsWith(BLOCKS_FOLDER)) return null;
        const filename = path.slice(BLOCKS_FOLDER.length + 1);
        if (!filename.endsWith(".json")) return null;
        return decodeURIComponent(filename.replace(".json", ""));
      },
    },

    /** The blocks folder path */
    blocksFolder: BLOCKS_FOLDER,

    /** The .deco folder name */
    dirname: DECO_FOLDER,

    /** The decofile.json build file path */
    buildFile: `${DECO_FOLDER}/decofile.json`,

    /** The metadata.json file path */
    metadataPath: `/${DECO_FOLDER}/metadata.json`,
  },
};

/**
 * Determine block type from __resolveType string.
 */
export function getBlockType(resolveType: string): BlockType {
  if (resolveType.includes("/pages/")) return "pages";
  if (resolveType.includes("/sections/")) return "sections";
  if (resolveType.includes("/loaders/")) return "loaders";
  if (resolveType.includes("/actions/")) return "actions";
  if (resolveType.includes("/apps/")) return "apps";
  if (resolveType.includes("/flags/")) return "flags";
  if (resolveType.includes("/handlers/")) return "handlers";
  if (resolveType.includes("/matchers/")) return "matchers";
  if (resolveType.includes("/workflows/")) return "workflows";

  // Check for specific patterns
  if (resolveType.includes("redirects")) return "redirects";

  // Default to sections for unknown types
  return "sections";
}

/**
 * Infer metadata from a block's content.
 *
 * @example
 * const metadata = inferMetadata({
 *   __resolveType: 'website/pages/Page.tsx',
 *   name: 'Home',
 *   path: '/'
 * });
 * // Returns: { blockType: 'pages', __resolveType: '...', name: 'Home', path: '/' }
 */
export function inferMetadata(block: Block): BlockMetadata | null {
  const resolveType = block.__resolveType;
  if (!resolveType) return null;

  const blockType = getBlockType(resolveType);

  return {
    blockType,
    __resolveType: resolveType,
    name: block.name as string | undefined,
    path: block.path as string | undefined,
  };
}

/**
 * Check if a block is a page.
 */
export function isPage(block: Block | null | undefined): boolean {
  if (!block?.__resolveType) return false;
  return getBlockType(block.__resolveType) === "pages";
}

/**
 * Check if a block is a section.
 */
export function isSection(block: Block | null | undefined): boolean {
  if (!block?.__resolveType) return false;
  return getBlockType(block.__resolveType) === "sections";
}

/**
 * Check if a block is a loader.
 */
export function isLoader(block: Block | null | undefined): boolean {
  if (!block?.__resolveType) return false;
  return getBlockType(block.__resolveType) === "loaders";
}

/**
 * Check if a block is an action.
 */
export function isAction(block: Block | null | undefined): boolean {
  if (!block?.__resolveType) return false;
  return getBlockType(block.__resolveType) === "actions";
}

/**
 * Check if a block is an app.
 */
export function isApp(block: Block | null | undefined): boolean {
  if (!block?.__resolveType) return false;
  return getBlockType(block.__resolveType) === "apps";
}

