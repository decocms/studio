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
 * Mustache template — a plain title carries no props and is already covered by
 * the resolve-type-derived label.
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

/**
 * Resolve a section's display name from its component's `@title` Mustache
 * template, evaluated against the section's own props. Returns undefined when
 * there is no template, it renders empty, or rendering fails — callers fall
 * back to the resolve-type-derived label.
 */
export function getSectionDisplayTitle(
  formData: RawSection,
  meta: LiveMeta | null | undefined,
): string | undefined {
  if (!meta) return undefined;

  const ctx = resolveSectionPreviewContext(formData);
  if (!ctx) return undefined;

  try {
    const titleTpl = resolveSectionTitleTemplate(ctx.resolveType, meta);
    if (!titleTpl) return undefined;
    const rendered = Mustache.render(titleTpl, ctx.data, {}, RENDER_CONFIG);
    return rendered.trim() || undefined;
  } catch {
    return undefined;
  }
}
