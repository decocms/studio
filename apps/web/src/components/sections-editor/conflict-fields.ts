import type { SchemaProperty } from "./resolve-schema";

const MAX_LISTED = 3;

/**
 * The labels of one JSON pointer's steps. With the form's `schema`, a step
 * reads as the field's label in the form (its title); positions count from 1,
 * as the editor shows them; a step the schema doesn't describe keeps its key.
 */
function pointerLabels(
  pointer: string,
  schema?: SchemaProperty | null,
  titleUntitled = false,
) {
  let node: SchemaProperty | null | undefined = schema;
  return pointer
    .split("/")
    .slice(1)
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .map((part) => {
      if (/^\d+$/.test(part) && (!node || !node.properties?.[part])) {
        node = node?.items;
        return String(Number(part) + 1);
      }
      const field: SchemaProperty | undefined = node?.properties?.[part];
      node = field;
      const title = field?.title?.trim();
      return title ? title : titleUntitled ? titleOfKey(part) : part;
    });
}

/**
 * A key the schema gives no title, titled as the form's default titles are
 * (`deco schema` splits a key at its capitals): "aboutText" reads "About
 * Text".
 */
function titleOfKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/^\p{Ll}/u, (c) => c.toUpperCase());
}

/**
 * One value's label as the form shows it: `/slides/0/title` reads "Slides ›
 * 1 › Title" with the section's schema, "slides › 1 › title" without
 * ("Slides › 1 › Title" with `titleUntitled`, as a hosted v8 window labels
 * a key its schema doesn't title).
 */
export function conflictFieldLabel(
  pointer: string,
  schema?: SchemaProperty | null,
  titleUntitled = false,
): string {
  const parts = pointerLabels(pointer, schema, titleUntitled);
  return parts.length > 0 ? parts.join(" › ") : "*";
}

/**
 * Human-readable list of the values an edit and the stored block both
 * changed, from their JSON pointers: `/slides/0/title` reads "slides › 1 ›
 * title", or with the section's schema the form's own labels ("Slides › 1 ›
 * Title"). Lists at most three and counts the rest.
 */
export function describeConflictFields(
  pointers: string[],
  schema?: SchemaProperty | null,
): string {
  const labels = [
    ...new Set(pointers.map((pointer) => conflictFieldLabel(pointer, schema))),
  ];
  const shown = labels.slice(0, MAX_LISTED).join(", ");
  const rest = labels.length - MAX_LISTED;
  return rest > 0 ? `${shown} (+${rest})` : shown;
}
