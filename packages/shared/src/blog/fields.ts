/**
 * The small reads every other blog module is built out of.
 *
 * Nothing here knows what a post is for — they answer "is this an object",
 * "what string is this", "which required fields are missing". They sit at the
 * bottom because the editor's validation and the generation tools' validation
 * have to agree about an empty field, and two implementations of "missing"
 * disagree the first time one of them is fixed.
 */

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * A category on a post can be a plain slug string or a `{ name, slug }`
 * object (deco denormalizes the latter). Tolerate both.
 */
export function categorySlugOf(item: unknown): string {
  if (typeof item === "string") return item;
  const rec = asRecord(item);
  return rec ? str(rec.slug) : "";
}

/** Authors are denormalized as `{ name, email }`; tolerate plain strings. */
export function authorEmailOf(item: unknown): string {
  if (typeof item === "string") return item;
  const rec = asRecord(item);
  return rec ? str(rec.email) : "";
}

/**
 * A required field a blog record can be missing. Identifies the field, never
 * names it: the name shown to the reader is a translation, resolved by
 * {@link missingFieldsLabel} at render time.
 */
export type MissingFieldKey =
  | "title"
  | "slug"
  | "category"
  | "excerpt"
  | "image"
  | "name";

/**
 * Which required fields a post payload is missing (empty ⇒ valid). A post with
 * no title/slug/excerpt or zero categories is incomplete — the list marks it
 * and the editor blocks preview.
 */
export function missingPostFields(
  payload: Record<string, unknown>,
): MissingFieldKey[] {
  const missing: MissingFieldKey[] = [];
  if (!str(payload.title).trim()) missing.push("title");
  if (!str(payload.slug).trim()) missing.push("slug");
  if (
    toArray(payload.categories).map(categorySlugOf).filter(Boolean).length === 0
  ) {
    missing.push("category");
  }
  if (!str(payload.excerpt).trim()) missing.push("excerpt");
  if (!str(payload.image).trim()) missing.push("image");
  return missing;
}

/**
 * Which required fields a category payload is missing (empty ⇒ valid). A
 * category with no name or slug resolves to nothing on the site: the slug is
 * its URL and the name is what every post denormalizes. Mirrors
 * {@link missingPostFields}.
 */
export function missingCategoryFields(
  payload: Record<string, unknown>,
): MissingFieldKey[] {
  const missing: MissingFieldKey[] = [];
  if (!str(payload.name).trim()) missing.push("name");
  if (!str(payload.slug).trim()) missing.push("slug");
  return missing;
}

export function randomHex(length: number): string {
  const bytes = new Uint8Array(Math.ceil(length / 2));
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, length);
}

/** A fresh id for a new lifecycle post, unique enough for a per-site decofile. */
export function newPostId(): string {
  return randomHex(12);
}

/** Casing, accents and spacing are presentation, not identity. */
export function normalizeTitleKey(title: string): string {
  return title
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** A named piece of brand guidance: a writing rule, or a post format. */
export interface BrandRule {
  name: string;
  value: string;
}
