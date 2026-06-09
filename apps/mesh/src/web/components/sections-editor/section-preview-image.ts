import Mustache from "mustache";
import { resolveImageValues } from "./array-item-display";
import type { LiveMeta } from "./resolve-schema";
import { isLazyResolveType } from "./section-lazy";
import { NEVER_MATCHER_RESOLVE_TYPE, type RawSection } from "./section-types";

type RawSchema = Record<string, unknown>;

function schemaDefinitions(meta: LiveMeta): Record<string, RawSchema> {
  return (meta.schema?.definitions ?? meta.schema?.$defs ?? {}) as Record<
    string,
    RawSchema
  >;
}

/** Same as admin `isInVariantDraft`. */
function isInVariantDraft(formData: RawSection): boolean {
  const variants = formData.variants;
  if (!Array.isArray(variants) || variants.length !== 1) return false;
  return (
    (variants[0]?.rule?.__resolveType as string | undefined) ===
    NEVER_MATCHER_RESOLVE_TYPE
  );
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

  const isAsyncRender = isLazyResolveType(formData.__resolveType ?? "");
  const isHidden = isInVariantDraft(formData);

  let resolveType: string | undefined = formData.__resolveType;

  if (isAsyncRender) {
    resolveType = formData.section?.__resolveType as string | undefined;
  }
  if (isHidden) {
    const variant = formData.variants?.[0]?.value as RawSection | undefined;
    const vrt = variant?.__resolveType;
    if (vrt && isLazyResolveType(vrt)) {
      resolveType = variant.section?.__resolveType as string | undefined;
    } else if (vrt) {
      resolveType = vrt;
    }
  }

  if (!resolveType) return undefined;

  const imageTpl = resolveSectionImageTemplate(resolveType, meta);
  if (!imageTpl) return undefined;

  const variantValue = formData.variants?.[0]?.value as RawSection | undefined;

  const data = isAsyncRender
    ? (formData.section as Record<string, unknown> | undefined)
    : isHidden
      ? isLazyResolveType(variantValue?.__resolveType ?? "")
        ? (variantValue?.section as Record<string, unknown> | undefined)
        : (variantValue as Record<string, unknown> | undefined)
      : (formData as Record<string, unknown>);

  if (!data) return undefined;

  const resolved = Mustache.render(imageTpl, resolveImageValues(data));
  return resolved || undefined;
}
