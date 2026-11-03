import { isManifestBlockResolveType } from "@/components/sections-editor/block-type-utils.ts";
import { cachedResolveSchema } from "@/components/sections-editor/fields/resolved-schema-cache.ts";
import type { LiveMeta } from "@/components/sections-editor/resolve-schema.ts";
import {
  type MissingRequiredField,
  missingRequiredFields,
} from "@/components/sections-editor/section-required-status.ts";
import type { PublishChange } from "./publish-change-summary.ts";

/** A change whose new content leaves required fields empty. */
export interface PublishRequiredFields {
  change: PublishChange;
  fields: MissingRequiredField[];
}

/** Matches the form's structural cap; a page is far shallower. */
const MAX_DEPTH = 32;

/**
 * The required fields each change's new content leaves empty, judged like the
 * editor's required markers. Every block inside it is judged by its own
 * schema (a page's sections, a lazy section's inner one). A reference to
 * another saved block isn't: that block is judged when it changes. Blocks the
 * schema doesn't know are skipped, never guessed at.
 */
export function publishRequiredFields(
  changes: readonly PublishChange[],
  meta: LiveMeta,
): PublishRequiredFields[] {
  return changes.flatMap((change) => {
    if (!change.toJson) return [];
    const fields = blockMissingFields(change.toJson, meta, [], [], 0);
    return fields.length > 0 ? [{ change, fields }] : [];
  });
}

function blockMissingFields(
  value: unknown,
  meta: LiveMeta,
  path: Array<string | number>,
  labels: Array<string | number>,
  depth: number,
): MissingRequiredField[] {
  if (depth > MAX_DEPTH || value === null || typeof value !== "object") {
    return [];
  }
  const own: MissingRequiredField[] = [];
  const resolveType = (value as Record<string, unknown>).__resolveType;
  if (
    !Array.isArray(value) &&
    typeof resolveType === "string" &&
    isManifestBlockResolveType(meta, resolveType)
  ) {
    own.push(
      ...missingRequiredFields(cachedResolveSchema(resolveType, meta), value, {
        path,
        labels,
      }),
    );
  }
  const nested = Array.isArray(value)
    ? value.flatMap((item, index) =>
        blockMissingFields(
          item,
          meta,
          [...path, index],
          [...labels, index],
          depth + 1,
        ),
      )
    : Object.entries(value).flatMap(([key, item]) =>
        blockMissingFields(
          item,
          meta,
          [...path, key],
          [...labels, key],
          depth + 1,
        ),
      );
  // A block in an object-typed prop is also reached by its parent's schema.
  const seen = new Set(own.map((field) => field.path.join("\u0000")));
  return [
    ...own,
    ...nested.filter((field) => !seen.has(field.path.join("\u0000"))),
  ];
}

/** Whether any of them stops a Publish: a field `deco check` rejects. */
export function requiredFieldsBlockPublish(
  found: readonly PublishRequiredFields[],
): boolean {
  return found.some(({ fields }) => fields.some((field) => field.blocks));
}

/**
 * The Publish dialog's required-fields check. Without a schema nothing is
 * judged. While the changes' content loads (and hasn't failed to), a Publish
 * waits for it. A review submission publishes nothing, so it is never held.
 */
export function publishRequiredFieldsGate(args: {
  meta: LiveMeta | undefined;
  changes: readonly PublishChange[];
  contentPending: boolean;
  contentFailed: boolean;
  review: boolean;
}): { found: PublishRequiredFields[]; checking: boolean; blocks: boolean } {
  const { meta, changes, contentPending, contentFailed, review } = args;
  const checking = !!meta && contentPending && !contentFailed;
  const found = meta && !checking ? publishRequiredFields(changes, meta) : [];
  return {
    found,
    checking: checking && !review,
    blocks: !review && (checking || requiredFieldsBlockPublish(found)),
  };
}

/** "Cards › 1 › Headline": array positions count from 1. */
export function requiredFieldLabel(field: MissingRequiredField): string {
  return field.labels
    .map((label) => (typeof label === "number" ? String(label + 1) : label))
    .join(" › ");
}
