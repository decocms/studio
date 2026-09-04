import type { BlogKind } from "./blog/blog-data";

export type CollectionId =
  | "pages"
  | "sections"
  | "apps"
  | "site"
  | "seo"
  | "calendar"
  | "post-schedule"
  | "loaders"
  | "actions"
  | "redirects"
  | BlogKind;

export const COMPACT_CONTENT_WORKSPACE_WIDTH = 840;

export type CompactContentStage = "collections" | "items" | "detail";

export function isCompactContentWorkspace(width: number): boolean {
  return width >= 0 && width < COMPACT_CONTENT_WORKSPACE_WIDTH;
}

export function collectionStartStage(
  collection: CollectionId,
): Exclude<CompactContentStage, "collections"> {
  switch (collection) {
    case "site":
    case "seo":
    case "calendar":
    case "post-schedule":
    case "loaders":
    case "actions":
      return "detail";
    case "pages":
    case "sections":
    case "apps":
    case "redirects":
    case "posts":
    case "authors":
    case "categories":
      return "items";
    default: {
      const exhaustiveCollection: never = collection;
      return exhaustiveCollection;
    }
  }
}

/** Restore the semantic view when a wide three-rail workspace becomes compact. */
export function compactStageForCurrentView(
  collection: CollectionId,
  hasSelection: boolean,
): Exclude<CompactContentStage, "collections"> {
  return hasSelection ? "detail" : collectionStartStage(collection);
}
