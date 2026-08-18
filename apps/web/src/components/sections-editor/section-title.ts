import Mustache from "mustache";
import type { LiveMeta } from "./resolve-schema";
import { resolveSectionPreviewContext } from "./section-variants";
import type { RawSection } from "./section-types";

type RawSchema = Record<string, unknown>;

/** Render the label as plain text — the section name is shown as-is, never as
 * HTML, so the default entity-escaping (`&` → `&amp;`) would corrupt it. */
const RENDER_CONFIG = { escape: (value: unknown) => String(value) };

function schemaDefinitions(meta: LiveMeta): Record<string, RawSchema> {
  return (meta.schema?.definitions ?? meta.schema?.$defs ?? {}) as Record<
    string,
    RawSchema
  >;
}

/**
 * Read the `@title` template from `definitions[btoa(resolveType)]`, following
 * allOf → Props (mirror of `resolveSectionImageTemplate`). Only returns a value
 * when the title is a Mustache template — a plain title carries no props and is
 * already covered by the resolve-type-derived label.
 */
export function resolveSectionTitleTemplate(
  resolveType: string,
  meta: LiveMeta,
): string | undefined {
  const definitions = schemaDefinitions(meta);
  const schema = definitions[btoa(resolveType)];
  if (!schema) return undefined;

  let titleTpl = typeof schema.title === "string" ? schema.title : undefined;

  if (!titleTpl?.includes("{{") && Array.isArray(schema.allOf)) {
    const ref = (schema.allOf as RawSchema[]).find(
      (part) => typeof part.$ref === "string",
    )?.$ref;
    if (typeof ref === "string") {
      const refKey = ref.replace("#/definitions/", "");
      const propsSchema = definitions[refKey];
      titleTpl =
        typeof propsSchema?.title === "string" ? propsSchema.title : titleTpl;
    }
  }

  if (!titleTpl?.includes("{{")) return undefined;
  return titleTpl;
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

  const titleTpl = resolveSectionTitleTemplate(ctx.resolveType, meta);
  if (!titleTpl) return undefined;

  try {
    const rendered = Mustache.render(titleTpl, ctx.data, {}, RENDER_CONFIG);
    return rendered.trim() || undefined;
  } catch {
    return undefined;
  }
}
