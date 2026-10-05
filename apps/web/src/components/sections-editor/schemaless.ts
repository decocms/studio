/**
 * A Blocks site whose schema isn't generated yet (`deco schema` hasn't run).
 *
 * The content protocol still lists and saves every block without a schema;
 * only the typed forms need it. The editor reads "no schema" as an empty
 * schema carrying a marker (`noSchemaMeta`), so the poll keeps one shape and
 * the real schema replaces it on its own once it appears. Surfaces that would
 * otherwise build forms from the schema show the blocks grouped by type and a
 * form inferred from each block's JSON instead.
 *
 * Pure: unit-tested without mocks.
 */

import { type BatchOutcome, ErrorCode } from "@decocms/blocks/protocol";
import type { LiveMeta } from "./resolve-schema";

const NO_SCHEMA_MARKER = "__noSchema";

/** The schema of a site with none yet: empty, and marked as such. */
export function noSchemaMeta(): LiveMeta {
  return {
    manifest: { blocks: {} },
    schema: { definitions: {}, root: {} },
    [NO_SCHEMA_MARKER]: true,
  } as LiveMeta;
}

/** Whether `meta` stands in for a site with no schema yet. */
export function isNoSchemaMeta(meta: LiveMeta | null | undefined): boolean {
  return (
    !!meta &&
    (meta as unknown as Record<string, unknown>)[NO_SCHEMA_MARKER] === true
  );
}

/**
 * Whether a `schema.get` outcome says there's no schema yet: `schema: null`,
 * or NotFound from a `deco serve` older than that result.
 */
export function isSchemaAbsent(outcome: BatchOutcome): boolean {
  if (!outcome.ok) return outcome.error.code === ErrorCode.NotFound;
  const result = outcome.result as { notModified?: boolean; schema?: unknown };
  return result.notModified === false && result.schema === null;
}

export interface SchemalessBlock {
  key: string;
  label: string;
}

export interface SchemalessGroup {
  /** The blocks' `__resolveType`; `null` for blocks without one. */
  resolveType: string | null;
  blocks: SchemalessBlock[];
}

function blockLabel(key: string, block: Record<string, unknown>): string {
  const name = typeof block.name === "string" ? block.name.trim() : "";
  return name || key;
}

const byLabel = (a: SchemalessBlock, b: SchemalessBlock) =>
  a.label.localeCompare(b.label) || a.key.localeCompare(b.key);

/** Every saved block, grouped by `__resolveType` and sorted by name. */
export function groupBlocksByType(
  decofile: Record<string, unknown>,
): SchemalessGroup[] {
  const groups = new Map<string | null, SchemalessBlock[]>();
  for (const [key, value] of Object.entries(decofile)) {
    const block =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    const resolveType =
      typeof block.__resolveType === "string" ? block.__resolveType : null;
    const list = groups.get(resolveType) ?? [];
    list.push({ key, label: blockLabel(key, block) });
    groups.set(resolveType, list);
  }
  return [...groups.entries()]
    .map(([resolveType, blocks]) => ({
      resolveType,
      blocks: blocks.sort(byLabel),
    }))
    .sort((a, b) =>
      a.resolveType === null
        ? 1
        : b.resolveType === null
          ? -1
          : typeLabel(a.resolveType).localeCompare(typeLabel(b.resolveType)) ||
            a.resolveType.localeCompare(b.resolveType),
    );
}

/** `site/sections/Header.tsx` → `Header`. */
export function typeLabel(resolveType: string): string {
  const last = resolveType.split("/").filter(Boolean).at(-1) ?? resolveType;
  return last.replace(/\.(tsx?|jsx?)$/, "") || resolveType;
}

export type JsonPath = readonly (string | number)[];

/**
 * `value` with the leaf at `path` replaced; everything else, key order
 * included, stays exactly as it was.
 */
export function setAtPath(
  value: unknown,
  path: JsonPath,
  leaf: unknown,
): unknown {
  if (path.length === 0) return leaf;
  const [head, ...rest] = path;
  if (Array.isArray(value) && typeof head === "number") {
    const next = value.slice();
    next[head] = setAtPath(value[head], rest, leaf);
    return next;
  }
  if (value && typeof value === "object" && typeof head === "string") {
    const record = value as Record<string, unknown>;
    const next: Record<string, unknown> = {};
    for (const key of Object.keys(record)) {
      next[key] =
        key === head ? setAtPath(record[key], rest, leaf) : record[key];
    }
    return next;
  }
  return value;
}

/** A number typed into a field, or `null` while it isn't one yet. */
export function parseNumberInput(text: string): number | null {
  if (text.trim() === "") return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}
