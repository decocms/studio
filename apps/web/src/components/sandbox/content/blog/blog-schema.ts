/**
 * Blog record props, read from the SITE's own schema instead of a list
 * hardcoded here.
 *
 * Each blog record is a loader block (`blog/loaders/{Blogpost,Author,
 * Category}.ts`) whose editable payload sits under a wrapper key — see
 * `blog-data.ts`. The loader's props schema is published in the site's
 * `/live/_meta`, so a client who forks the blog app and adds a field to
 * `Author` already ships the schema for it; Studio only has to read it.
 *
 * The editors stay hybrid on purpose. The keys in the `KNOWN_*` sets below are
 * owned by bespoke UI (slug dedupe, the category rename cascade, status
 * promotion, the block-document body) and are never rendered generically;
 * everything else the schema declares goes to `SchemaForm`.
 */
import {
  type LiveMeta,
  type SchemaProperty,
} from "@/components/sections-editor/resolve-schema";
import { cachedResolveSchema } from "@/components/sections-editor/fields/resolved-schema-cache";
import { RESOLVE_TYPE_FOR_KIND, WRAPPER_KEY, type BlogKind } from "./blog-data";

/**
 * The record type's own schema — `BlogPost` / `Author` / `Category` — taken
 * from the loader's props and unwrapped past the wrapper key.
 *
 * `null` whenever that assumption does not hold: no meta, the loader is not in
 * the manifest, or its props are not shaped `{ <wrapper>: <object> }`. Callers
 * keep their hardcoded field list then. There is deliberately NO fallback to
 * the unwrapped props: a fork whose loader takes query props instead
 * (`{ slug }`, `{ page, pageSize }`) would otherwise render those inputs as if
 * they were record fields and write them into the stored payload.
 *
 * Goes through `cachedResolveSchema` because resolving a post materializes its
 * `sections: Section[]` into the site-wide `__SECTION_REF__` union before we
 * get to drop it — far too expensive to redo on every render.
 */
export function resolveBlogRecordSchema(
  kind: BlogKind,
  meta: LiveMeta | undefined,
): SchemaProperty | null {
  if (!meta) return null;
  const props = cachedResolveSchema(RESOLVE_TYPE_FOR_KIND[kind], meta);
  const wrapped = props?.properties?.[WRAPPER_KEY[kind]];
  if (!wrapped) return null;
  // A record type doubles as a referenceable block, so deco publishes the
  // wrapper as a union of "the record inline" and "a pointer at a saved
  // record". `plainSchema` is that inline branch — the shape the editor edits.
  const record = wrapped.properties ? wrapped : wrapped.plainSchema;
  return record?.properties ? record : null;
}

/** Keys no form should ever show, whatever the schema says. */
const NEVER_RENDERED = new Set(["__resolveType", "@type"]);

/**
 * `schema` minus the keys Studio owns. `required` is dropped outright: a field
 * only the fork knows about must never block a record the editor considers
 * complete. `null` when nothing is left, so no empty panel is rendered.
 */
export function customFieldsSchema(
  schema: SchemaProperty | null,
  known: ReadonlySet<string>,
): SchemaProperty | null {
  const properties = schema?.properties;
  if (!properties) return null;
  const rest = Object.fromEntries(
    Object.entries(properties).filter(
      ([key, prop]) =>
        !known.has(key) && !NEVER_RENDERED.has(key) && prop.hidden !== true,
    ),
  );
  if (Object.keys(rest).length === 0) return null;
  return { type: "object", properties: rest };
}

/** {@link resolveBlogRecordSchema} then {@link customFieldsSchema}, for one kind. */
export function blogCustomFieldsSchema(
  kind: BlogKind,
  meta: LiveMeta | undefined,
  known: ReadonlySet<string>,
): SchemaProperty | null {
  return customFieldsSchema(resolveBlogRecordSchema(kind, meta), known);
}

/**
 * Post keys owned by `post-editor.tsx`. The `setField` signatures there are
 * typed from this tuple, so a new bespoke field fails to compile until it is
 * listed — which is what keeps a field from rendering twice.
 */
const KNOWN_POST_KEYS = [
  // Bespoke UI in `PostSettings` and the editor header.
  "title",
  "slug",
  "excerpt",
  "date",
  "readTime",
  "image",
  "mobileImage",
  "alt",
  "authors",
  "categories",
  "sections",
  "seo",
  "extraProps",
  "scheduledDatetime",
  // Owned by Studio too, but written by status moves / `stampPostModified`.
  "status",
  "dateModified",
  "planning",
  // Pre-`sections` rich-text body; showing it would rival the block document.
  "content",
] as const;

export type KnownPostKey = (typeof KNOWN_POST_KEYS)[number];

export const KNOWN_POST_FIELDS: ReadonlySet<string> = new Set(KNOWN_POST_KEYS);

/** Category keys owned by `category-editor.tsx`. See {@link KNOWN_POST_KEYS}. */
const KNOWN_CATEGORY_KEYS = [
  "name",
  "slug",
  "parentSlug",
  "description",
  "sections",
] as const;

export type KnownCategoryKey = (typeof KNOWN_CATEGORY_KEYS)[number];

export const KNOWN_CATEGORY_FIELDS: ReadonlySet<string> = new Set(
  KNOWN_CATEGORY_KEYS,
);
