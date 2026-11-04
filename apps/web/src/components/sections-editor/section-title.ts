import { isV8Schema } from "@decocms/shared/blocks-major";
import Mustache from "mustache";
import { formatMustacheValue } from "./array-item-display";
import type { LiveMeta } from "./resolve-schema";
import { sectionSchemaChain } from "./section-schema";
import { resolveSectionPreviewContext } from "./section-variants";
import type { RawSection } from "./section-types";

/** Render the label as plain text — the section name is shown as-is, never as
 * HTML, so the default entity-escaping (`&` → `&amp;`) would corrupt it. An
 * object/array prop collapses to `""`/a join instead of `[object Object]`. */
const RENDER_CONFIG = { escape: formatMustacheValue };

/**
 * Read the `@title` template from the section's schema chain (mirror of
 * `resolveSectionImageTemplate`). Only returns a value when the title is a
 * Mustache template; {@link getSectionDisplayTitle} reads a plain title.
 */
export function resolveSectionTitleTemplate(
  resolveType: string,
  meta: LiveMeta,
): string | undefined {
  for (const schema of sectionSchemaChain(resolveType, meta)) {
    const title = typeof schema.title === "string" ? schema.title : undefined;
    if (title?.includes("{{")) return title;
  }
  return undefined;
}

function renderTitleTemplate(
  template: string,
  data: Record<string, unknown>,
): string | undefined {
  try {
    return (
      Mustache.render(template, data, {}, RENDER_CONFIG).trim() || undefined
    );
  } catch {
    return undefined;
  }
}

/** The section's `@title`, rendered against its props when it's a template. */
export function getSectionDisplayTitle(
  formData: RawSection,
  meta: LiveMeta | null | undefined,
): string | undefined {
  if (!meta) return undefined;

  const ctx = resolveSectionPreviewContext(formData, isV8Schema(meta));
  if (!ctx) return undefined;

  const titleTpl = resolveSectionTitleTemplate(ctx.resolveType, meta);
  const rendered = titleTpl && renderTitleTemplate(titleTpl, ctx.data);
  if (rendered) return rendered;

  return resolveSectionPlainTitle(ctx.resolveType, meta);
}

/**
 * The first authored plain `@title` in the section's schema chain. Without
 * one, deco titles the definition with the file path (`resolveType`, or
 * `resolveType@Props` on Props), which the resolve-type label already shortens.
 */
function resolveSectionPlainTitle(
  resolveType: string,
  meta: LiveMeta,
): string | undefined {
  for (const schema of sectionSchemaChain(resolveType, meta)) {
    const title = typeof schema.title === "string" ? schema.title.trim() : "";
    if (
      !title ||
      title.includes("{{") ||
      title === resolveType ||
      title.startsWith(`${resolveType}@`)
    ) {
      continue;
    }
    return title;
  }
  return undefined;
}
