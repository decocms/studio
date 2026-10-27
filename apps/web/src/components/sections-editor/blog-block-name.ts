/**
 * A blog record (a post, a category, an author) in words. Its block `name`
 * is its key (`collections/blog/posts/<id>`, or `blog-manager/posts/<id>`
 * while it's planned), never something to show: it is named by its title
 * (a category or author by its name), else by its kind ("Post").
 */

import { translate, type TranslationKey } from "@/i18n/use-t";

export type BlogBlockKind = "post" | "category" | "author";

const BLOG_KEY =
  /^(?:collections\/blog|blog-manager)\/(posts|categories|authors)\//;
const KIND_OF_FOLDER: Record<string, BlogBlockKind> = {
  posts: "post",
  categories: "category",
  authors: "author",
};
const WRAPPERS: readonly BlogBlockKind[] = ["post", "category", "author"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** The kind of blog record `blockKey` (or its copy) is; null for any other block. */
export function blogBlockKind(
  blockKey: string | null,
  ...copies: unknown[]
): BlogBlockKind | null {
  const folder = blockKey ? BLOG_KEY.exec(blockKey)?.[1] : undefined;
  if (folder) return KIND_OF_FOLDER[folder] ?? null;
  for (const copy of copies) {
    if (!isRecord(copy)) continue;
    const resolveType = copy.__resolveType;
    if (typeof resolveType !== "string" || !resolveType.startsWith("blog/")) {
      continue;
    }
    const kind = WRAPPERS.find((wrapper) => isRecord(copy[wrapper]));
    if (kind) return kind;
  }
  return null;
}

/** A blog record's own title (or name), from the first copy that has one. */
export function blogBlockTitle(...copies: unknown[]): string | null {
  for (const copy of copies) {
    if (!isRecord(copy)) continue;
    for (const wrapper of WRAPPERS) {
      const payload = copy[wrapper];
      if (!isRecord(payload)) continue;
      for (const field of ["title", "name"]) {
        const value = payload[field];
        if (typeof value === "string" && value.trim()) return value.trim();
      }
    }
  }
  return null;
}

/** "Post", "Category" or "Author", translated. */
export function blogKindWord(
  kind: BlogBlockKind,
  t: (key: TranslationKey) => string = translate,
): string {
  return t(`sectionsEditor.blogKind.${kind}`);
}

/** A blog record's name in words: its title, else its kind. */
export function blogBlockName(
  kind: BlogBlockKind,
  copies: unknown[],
  t?: (key: TranslationKey) => string,
): string {
  return blogBlockTitle(...copies) ?? blogKindWord(kind, t);
}
