import { isSecretBlock } from "@decocms/shared/decofile";
import type { ContentCheck } from "@decocms/shared/sdk/types/virtual-mcp";
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
 * schema doesn't know are skipped, never guessed at, and so are secrets: older
 * sites store them as `encrypted`, which the schema's `ciphertext` doesn't match.
 *
 * With `changes`, a field the published version already left missing is only
 * listed: the site runs with it, and holding the Publish would block every
 * later edit of that block.
 */
export function publishRequiredFields(
  changes: readonly PublishChange[],
  meta: LiveMeta,
  check: Exclude<ContentCheck, "none"> = "all",
): PublishRequiredFields[] {
  return changes.flatMap((change) => {
    if (!change.toJson) return [];
    let fields = blockMissingFields(change.toJson, meta, [], [], 0);
    if (check === "changes" && change.fromJson) {
      const before = new Set(
        blockMissingFields(change.fromJson, meta, [], [], 0)
          .filter((field) => field.blocks)
          .map((field) => pathKey(field.path)),
      );
      fields = fields.map((field) =>
        field.blocks && before.has(pathKey(field.path))
          ? { ...field, blocks: false }
          : field,
      );
    }
    return fields.length > 0 ? [{ change, fields }] : [];
  });
}

const pathKey = (path: ReadonlyArray<string | number>) => path.join("\u0000");

function blockMissingFields(
  value: unknown,
  meta: LiveMeta,
  path: Array<string | number>,
  labels: Array<string | number>,
  depth: number,
): MissingRequiredField[] {
  if (
    depth > MAX_DEPTH ||
    value === null ||
    typeof value !== "object" ||
    isSecretBlock(value)
  ) {
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
  const seen = new Set(own.map((field) => pathKey(field.path)));
  return [...own, ...nested.filter((field) => !seen.has(pathKey(field.path)))];
}

/** Whether any of them stops a Publish: a field `deco check` rejects. */
export function requiredFieldsBlockPublish(
  found: readonly PublishRequiredFields[],
): boolean {
  return found.some(({ fields }) => fields.some((field) => field.blocks));
}

/**
 * The Publish dialog's required-fields check, per the site's `contentCheck`
 * (`changes` when unset). Without a schema, or with `none`, nothing is
 * judged. While the changes' content loads (and hasn't failed to), a Publish
 * waits for it. A review submission publishes nothing, so it is never held.
 */
export function publishRequiredFieldsGate(args: {
  meta: LiveMeta | undefined;
  check: ContentCheck | null | undefined;
  changes: readonly PublishChange[];
  contentPending: boolean;
  contentFailed: boolean;
  review: boolean;
}): { found: PublishRequiredFields[]; checking: boolean; blocks: boolean } {
  const { meta, changes, contentPending, contentFailed, review } = args;
  const check = args.check ?? "changes";
  if (!meta || check === "none") {
    return { found: [], checking: false, blocks: false };
  }
  const checking = contentPending && !contentFailed;
  const found = checking ? [] : publishRequiredFields(changes, meta, check);
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
