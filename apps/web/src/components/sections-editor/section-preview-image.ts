import { renderMustacheTemplate } from "./array-item-display";
import type { LiveMeta } from "./resolve-schema";
import { safeEditorImageUrl } from "./safe-editor-image-url";
import { resolveSectionPreviewContext } from "./section-variants";
import type { RawSection } from "./section-types";

type RawSchema = Record<string, unknown>;

function schemaDefinitions(meta: LiveMeta): Record<string, RawSchema> {
  return (meta.schema?.definitions ?? meta.schema?.$defs ?? {}) as Record<
    string,
    RawSchema
  >;
}

/**
 * Read `@image` from `definitions[btoa(resolveType)]`, following allOf → Props.
 * Port of admin `getItemImageSrc` schema lookup.
 */
export function resolveSectionImageTemplate(
  resolveType: string,
  meta: LiveMeta,
): string | undefined {
  const definitions = schemaDefinitions(meta);
  const schema = definitions[btoa(resolveType)];
  if (!schema) return undefined;

  let imageTpl = typeof schema.image === "string" ? schema.image : undefined;

  if (!imageTpl && Array.isArray(schema.allOf)) {
    const ref = (schema.allOf as RawSchema[]).find(
      (part) => typeof part.$ref === "string",
    )?.$ref;
    if (typeof ref === "string") {
      const refKey = ref.replace("#/definitions/", "");
      const propsSchema = definitions[refKey];
      imageTpl =
        typeof propsSchema?.image === "string" ? propsSchema.image : undefined;
    }
  }

  if (!imageTpl?.includes("{{{")) return undefined;
  return imageTpl;
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
