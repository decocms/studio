/**
 * Where a decofile uses a saved matcher block: every place a rule points at
 * it. The sections editor deletes a v7 site's saved rule once nothing uses
 * it (`countSavedMatcherBlockReferences`).
 */

import { isSavedMatcherBlockReference } from "./matcher-rules";
import { isPlainRecord } from "./named-rules";
import type { LiveMeta } from "./resolve-schema";
import { isMultivariateResolveType } from "./variant-shape";

/** Keys and indexes from a block's top to a value inside it. */
export type BlockPath = ReadonlyArray<string | number>;

/** A position in a decofile: the block, and the path inside it. */
export interface BlockLocation {
  blockKey: string;
  path: BlockPath;
}

/** Where the walk found a value: its parent's position and its key there. */
interface WalkEntry {
  node: unknown;
  blockKey: string;
  parent: WalkEntry | null;
  key: string | number | null;
}

function pathOf(entry: WalkEntry): BlockPath {
  const path: Array<string | number> = [];
  for (let at: WalkEntry | null = entry; at?.key != null; at = at.parent) {
    path.push(at.key);
  }
  return path.reverse();
}

function locationOf(entry: WalkEntry): BlockLocation {
  return { blockKey: entry.blockKey, path: pathOf(entry) };
}

/**
 * Visit every object reachable from the decofile, skipping the block stored
 * under `skipKey`. The walk is iterative so a deep block cannot overflow the
 * stack, and it memoizes object identity so malformed or cyclic user data
 * terminates. A consequence of the memo: an object reachable from two
 * positions is visited once, at one of them. A path is built only for the
 * objects a caller keeps (`locationOf`).
 */
function forEachDecofileObject(
  decofile: Record<string, unknown>,
  skipKey: string | null,
  visit: (node: Record<string, unknown>, at: WalkEntry) => void,
): void {
  const stack: WalkEntry[] = [];
  for (const [blockKey, node] of Object.entries(decofile)) {
    if (blockKey === skipKey) continue;
    stack.push({ node, blockKey, parent: null, key: null });
  }
  const seen = new Set<object>();
  while (stack.length > 0) {
    const entry = stack.pop()!;
    const { node } = entry;
    if (!node || typeof node !== "object") continue;
    if (seen.has(node)) continue;
    seen.add(node);
    if (Array.isArray(node)) {
      node.forEach((item, index) => {
        stack.push({
          node: item,
          blockKey: entry.blockKey,
          parent: entry,
          key: index,
        });
      });
      continue;
    }
    visit(node as Record<string, unknown>, entry);
    for (const [key, value] of Object.entries(node)) {
      stack.push({ node: value, blockKey: entry.blockKey, parent: entry, key });
    }
  }
}

/** The variant a rule belongs to, when it is a variant's rule. */
export interface RuleVariant {
  /** Path to the variants block (`multivariate`, or a v7 flag). */
  containerPath: BlockPath;
  containerType: string;
  index: number;
  /** The variants block's `experiment` (v8), when set. */
  experiment?: string;
}

/** A place that references a saved matcher block. */
export interface SavedRuleUse extends BlockLocation {
  variant?: RuleVariant;
}

/**
 * Every place that references the saved matcher block `blockKey`. Shape-blind
 * on purpose: every object in the decofile is inspected, not just page
 * variant rules, so a reference from a `multi` matcher at any depth, from a
 * section- or field-level variants block nested anywhere, or from any other
 * saved block (a global section, another saved matcher) is found. The block's
 * own body is skipped: a self-reference in malformed data would otherwise pin
 * it forever.
 */
export function findSavedMatcherReferences(
  decofile: Record<string, unknown>,
  blockKey: string,
  meta?: LiveMeta | null,
): SavedRuleUse[] {
  if (!blockKey) return [];
  const found: SavedRuleUse[] = [];
  forEachDecofileObject(decofile, blockKey, (node, at) => {
    if (node.__resolveType !== blockKey) return;
    if (!isSavedMatcherBlockReference(node, decofile, meta)) return;
    const variant = variantOf(at);
    found.push({ ...locationOf(at), ...(variant ? { variant } : {}) });
  });
  return found;
}

function variantOf(entry: WalkEntry): RuleVariant | undefined {
  // container.variants[index].rule…
  for (let at: WalkEntry | null = entry; at; at = at.parent) {
    const variant = at.parent;
    const list = variant?.parent;
    const container = list?.parent;
    if (!variant || !list || !container) return undefined;
    if (
      at.key === "rule" &&
      typeof variant.key === "number" &&
      list.key === "variants" &&
      isPlainRecord(container.node) &&
      isMultivariateResolveType(container.node.__resolveType)
    ) {
      const experiment = container.node.experiment;
      return {
        containerPath: pathOf(container),
        containerType: container.node.__resolveType as string,
        index: variant.key,
        ...(typeof experiment === "string" ? { experiment } : {}),
      };
    }
  }
  return undefined;
}
