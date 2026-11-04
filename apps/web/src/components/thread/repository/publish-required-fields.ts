import { isSecretBlock } from "@decocms/shared/decofile";
import type { ContentCheck } from "@decocms/shared/sdk/types/virtual-mcp";
import { isManifestBlockResolveType } from "@/components/sections-editor/block-type-utils.ts";
import { cachedResolveSchema } from "@/components/sections-editor/fields/resolved-schema-cache.ts";
import type {
  LiveMeta,
  SchemaProperty,
} from "@/components/sections-editor/resolve-schema.ts";
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
 * later edit of that block. It counts as already missing at the same path when
 * no list on the way changed length (so the item there is the same one), or
 * when an identical object lacked it before (items added ahead of it move it to
 * another index); each earlier one excuses one field.
 */
export function publishRequiredFields(
  changes: readonly PublishChange[],
  meta: LiveMeta,
  check: Exclude<ContentCheck, "none"> = "all",
): PublishRequiredFields[] {
  return changes.flatMap((change) => {
    const { fromJson, toJson } = change;
    if (!toJson) return [];
    let fields = blockMissingFields(toJson, meta, [], [], 0);
    if (check === "changes" && fromJson) {
      const before = blockMissingFields(fromJson, meta, [], [], 0).filter(
        (field) => field.blocks,
      );
      const samePath = new Set(
        before
          .filter((field) => sameItems(fromJson, toJson, field.path))
          .map((field) => pathKey(field.path)),
      );
      const owners = new Map<string, number>();
      for (const field of before) {
        const key = ownerKey(fromJson, field.path);
        owners.set(key, (owners.get(key) ?? 0) + 1);
      }
      const excuse = (field: MissingRequiredField) => {
        const owner = ownerKey(toJson, field.path);
        const left = owners.get(owner) ?? 0;
        if (left > 0) owners.set(owner, left - 1);
        return samePath.has(pathKey(field.path)) || left > 0;
      };
      fields = fields.map((field) =>
        field.blocks && excuse(field) ? { ...field, blocks: false } : field,
      );
    }
    return fields.length > 0 ? [{ change, fields }] : [];
  });
}

const pathKey = (path: ReadonlyArray<string | number>) => path.join("\u0000");

const step = (value: unknown, key: string | number): unknown =>
  value !== null && typeof value === "object"
    ? (value as Record<string | number, unknown>)[key]
    : undefined;

/** The missing field's name and the object that lacks it, by content. */
function ownerKey(root: unknown, path: ReadonlyArray<string | number>): string {
  const owner = path.slice(0, -1).reduce<unknown>(step, root);
  return `${String(path.at(-1))}\u0000${JSON.stringify(owner)}`;
}

/** Whether every list on the way to the field kept its length. */
function sameItems(
  from: unknown,
  to: unknown,
  path: ReadonlyArray<string | number>,
): boolean {
  let a = from;
  let b = to;
  for (const key of path.slice(0, -1)) {
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a) && a.length !== (b as unknown[]).length) return false;
    a = step(a, key);
    b = step(b, key);
  }
  return true;
}

/**
 * `schema` is the one for `value` when its parent's is known, so the labels on
 * the way to a nested block read as its parent's prop titles.
 */
function blockMissingFields(
  value: unknown,
  meta: LiveMeta,
  path: Array<string | number>,
  labels: Array<string | number>,
  depth: number,
  schema?: SchemaProperty,
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
  let here = schema;
  const resolveType = (value as Record<string, unknown>).__resolveType;
  if (
    !Array.isArray(value) &&
    typeof resolveType === "string" &&
    isManifestBlockResolveType(meta, resolveType)
  ) {
    here = cachedResolveSchema(resolveType, meta) ?? undefined;
    own.push(...missingRequiredFields(here, value, { path, labels }));
  }
  const nested = Array.isArray(value)
    ? value.flatMap((item, index) =>
        blockMissingFields(
          item,
          meta,
          [...path, index],
          [...labels, index],
          depth + 1,
          here?.items,
        ),
      )
    : Object.entries(value).flatMap(([key, item]) => {
        const child = here?.properties?.[key];
        return blockMissingFields(
          item,
          meta,
          [...path, key],
          [...labels, child?.title?.trim() || key],
          depth + 1,
          child,
        );
      });
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
 * (`none` when unset). Without a schema, or with `none`, nothing is
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
  const check = args.check ?? "none";
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
