import { renderMustacheTemplate } from "./array-item-display";
import type { LiveMeta } from "./resolve-schema";
import { safeEditorImageUrl } from "./safe-editor-image-url";
import { sectionSchemaChain } from "./section-schema";
import { resolveSectionPreviewContext } from "./section-variants";
import type { RawSection } from "./section-types";

/**
 * Read `@image` from the section's schema chain (own definition, then
 * allOf → Props). Port of admin `getItemImageSrc` schema lookup.
 */
export function resolveSectionImageTemplate(
  resolveType: string,
  meta: LiveMeta,
): string | undefined {
  for (const schema of sectionSchemaChain(resolveType, meta)) {
    const imageTpl =
      typeof schema.image === "string" ? schema.image : undefined;
    if (imageTpl?.includes("{{{")) return imageTpl;
  }
  return undefined;
}

/**
 * Section list thumbnail — direct port of admin `getItemImageSrc`.
 * Evaluated from raw section `formData` on each render (lazy/hidden detected inline).
 */
export function getSectionPreviewImageSrc(
  formData: RawSection,
  meta: LiveMeta | null | undefined,
): string | undefined {
  if (!meta) return undefined;

  const ctx = resolveSectionPreviewContext(formData);
  if (!ctx) return undefined;

  const imageTpl = resolveSectionImageTemplate(ctx.resolveType, meta);
  if (!imageTpl) return undefined;

  const rendered = renderMustacheTemplate(imageTpl, ctx.data);
  if (!rendered) return undefined;

  return safeEditorImageUrl(rendered);
}
