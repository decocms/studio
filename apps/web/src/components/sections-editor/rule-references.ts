/**
 * Where a decofile uses its rules: the saved matcher blocks a rule points at,
 * and the named rules (an A/B test's or a campaign's name, named-rules.ts)
 * every block refers to, plus the blocks that take a kind's whole map as a
 * prop. One walk serves both: deleting an unused saved rule and the "Used by"
 * lists of the Experiments and Campaigns views.
 */

import type { ChangeDetail } from "@decocms/blocks/protocol";
import { isSavedMatcherBlockReference } from "./matcher-rules";
import {
  canRenameExperiment,
  NAMED_RULE_KINDS,
  type NamedRuleKind,
  namedRule,
  namedRuleKindInfo,
  namedRuleKindOfBlock,
  namedRuleOf,
  readNamedRuleBlock,
  withRenamedNamedRuleEntry,
} from "./named-rules";
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

/** One block that uses a named rule. */
export interface RuleReference {
  kind: NamedRuleKind;
  name: string;
  /** The block that uses it. */
  blockKey: string;
  /**
   * Path to the rule in `blockKey`: the named rule itself, or (through a
   * saved rule) the reference to the saved rule.
   */
  path: BlockPath;
  variant?: RuleVariant;
  /**
   * Saved matcher blocks the rule is reached through, nearest to `blockKey`
   * first: `[]` when the block uses the named rule itself.
   */
  via: string[];
  /** `blockKey` is itself a saved matcher block (a saved rule). */
  savedRule: boolean;
}

/**
 * A block that takes a kind's whole map, as a prop or any other value
 * `{ "__resolveType": "experiments" }` (or `"campaigns"`): a section that
 * decides in its own code. It may read any name, so it is listed apart from
 * the uses by name.
 */
export interface WholeBlockReference {
  kind: NamedRuleKind;
  blockKey: string;
  /** Path to the reference in `blockKey`. */
  path: BlockPath;
}

/** One kind's uses: per name, and of the whole block. */
export interface KindReferences {
  byName: Map<string, RuleReference[]>;
  wholeBlock: WholeBlockReference[];
}

/** Per kind, the blocks that use it. */
export type RuleReferences = Record<NamedRuleKind, KindReferences>;

function emptyReferences(): RuleReferences {
  return {
    experiments: { byName: new Map(), wholeBlock: [] },
    campaigns: { byName: new Map(), wholeBlock: [] },
  };
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
      isRecord(container.node) &&
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

interface Hit {
  kind: NamedRuleKind;
  name: string;
  location: BlockLocation;
  variant?: RuleVariant;
}

/**
 * Every block that uses an A/B test or a campaign:
 *
 * - By name: a rule `experiment { name }` or `campaign { name }` anywhere (a
 *   variant's rule in a v8 `multivariate` or a v7 variants flag, inside a
 *   `multi`, inside a `lazy` value). A name in a rule is listed even when the
 *   `experiments`/`campaigns` block doesn't have it. Content isn't meant to
 *   keep such a rule in a saved rule block, but older content may: a block
 *   whose rule references a saved matcher block that uses the name (at any
 *   depth of saved rules) counts as using it, and so does the saved rule.
 *   A `date` rule with its own dates names no campaign and isn't listed.
 * - Whole: a value `{ "__resolveType": "experiments" }` or `"campaigns"`
 *   (a section prop), while that block is the kind's (or not saved yet).
 */
export function findRuleReferences(
  decofile: Record<string, unknown>,
  meta?: LiveMeta | null,
): RuleReferences {
  const hits: Hit[] = [];
  const out = emptyReferences();
  const wholeKinds = new Set(
    NAMED_RULE_KINDS.filter(
      (kind) => readNamedRuleBlock(decofile, kind).kind !== "conflict",
    ),
  );
  forEachDecofileObject(decofile, null, (node, at) => {
    const whole = namedRuleKindOfBlock(node.__resolveType);
    if (whole && wholeKinds.has(whole)) {
      out[whole].wholeBlock.push({ kind: whole, ...locationOf(at) });
      return;
    }
    const named = namedRuleOf(node);
    if (!named) return;
    hits.push({ ...named, location: locationOf(at), variant: variantOf(at) });
  });

  const add = (ref: RuleReference) => {
    const byName = out[ref.kind].byName;
    const list = byName.get(ref.name);
    if (list) list.push(ref);
    else byName.set(ref.name, [ref]);
  };
  const usesOfSavedRule = new Map<string, SavedRuleUse[]>();
  const savedRuleUses = (blockKey: string) => {
    let uses = usesOfSavedRule.get(blockKey);
    if (!uses) {
      uses = findSavedMatcherReferences(decofile, blockKey, meta);
      usesOfSavedRule.set(blockKey, uses);
    }
    return uses;
  };
  const isSavedRule = (blockKey: string) =>
    isSavedMatcherBlockReference({ __resolveType: blockKey }, decofile, meta);

  for (const hit of hits) {
    const { blockKey } = hit.location;
    const savedRule = isSavedRule(blockKey);
    add({
      kind: hit.kind,
      name: hit.name,
      blockKey,
      path: hit.location.path,
      ...(hit.variant ? { variant: hit.variant } : {}),
      via: [],
      savedRule,
    });
    if (!savedRule) continue;
    // Follow the saved rule to the blocks that use it, and on through any
    // saved rule that uses it in turn (a cycle stops at a rule seen before).
    const queue: Array<{ blockKey: string; via: string[] }> = [
      { blockKey, via: [blockKey] },
    ];
    const followed = new Set([blockKey]);
    while (queue.length > 0) {
      const { blockKey: rule, via } = queue.shift()!;
      for (const use of savedRuleUses(rule)) {
        const user = use.blockKey;
        // A saved rule reached through itself: a cycle, not another use.
        if (via.includes(user)) continue;
        const userIsSavedRule = isSavedRule(user);
        add({
          kind: hit.kind,
          name: hit.name,
          blockKey: user,
          path: use.path,
          ...(use.variant ? { variant: use.variant } : {}),
          via,
          savedRule: userIsSavedRule,
        });
        if (userIsSavedRule && !followed.has(user)) {
          followed.add(user);
          queue.push({ blockKey: user, via: [user, ...via] });
        }
      }
    }
  }
  return out;
}

/**
 * Whether the published site uses a reference, as the draft has it:
 *
 * - `published`: the published content has the same use (the same block,
 *   through the same saved rules).
 * - `draft-only`: the draft added it; it goes live with the next Publish.
 * - `removed-in-draft`: the published content still uses it; the draft
 *   dropped it, and it stops at the next Publish.
 */
export type ReferenceState = "published" | "draft-only" | "removed-in-draft";

export interface MarkedRuleReference extends RuleReference {
  state: ReferenceState;
}

export interface MarkedWholeBlockReference extends WholeBlockReference {
  state: ReferenceState;
}

export interface MarkedKindReferences {
  byName: Map<string, MarkedRuleReference[]>;
  wholeBlock: MarkedWholeBlockReference[];
}

export type MarkedRuleReferences = Record<NamedRuleKind, MarkedKindReferences>;

function referenceKey(ref: RuleReference): string {
  return JSON.stringify([ref.blockKey, ...ref.via]);
}

/**
 * `draft`, each marked against `published` by `keyOf`, plus the published
 * ones the draft no longer has (once per key).
 */
function markList<T>(
  draft: T[],
  published: T[],
  keyOf: (ref: T) => string,
): Array<T & { state: ReferenceState }> {
  const live = new Set(published.map(keyOf));
  const kept = new Set(draft.map(keyOf));
  const marked: Array<T & { state: ReferenceState }> = draft.map((ref) => ({
    ...ref,
    state: live.has(keyOf(ref)) ? "published" : "draft-only",
  }));
  const removed = new Set<string>();
  for (const ref of published) {
    const key = keyOf(ref);
    if (kept.has(key) || removed.has(key)) continue;
    removed.add(key);
    marked.push({ ...ref, state: "removed-in-draft" });
  }
  return marked;
}

/**
 * The draft's references, each marked against the published content's, plus
 * the published uses the draft no longer has. A block that uses a name (or
 * the whole block) more than once is compared as one use: the views list
 * blocks, not positions.
 */
export function markReferenceStates(
  draft: RuleReferences,
  published: RuleReferences,
): MarkedRuleReferences {
  const out = {} as MarkedRuleReferences;
  for (const kind of NAMED_RULE_KINDS) {
    const byName = new Map<string, MarkedRuleReference[]>();
    const names = new Set([
      ...draft[kind].byName.keys(),
      ...published[kind].byName.keys(),
    ]);
    for (const name of names) {
      byName.set(
        name,
        markList(
          draft[kind].byName.get(name) ?? [],
          published[kind].byName.get(name) ?? [],
          referenceKey,
        ),
      );
    }
    out[kind] = {
      byName,
      wholeBlock: markList(
        draft[kind].wholeBlock,
        published[kind].wholeBlock,
        (ref) => ref.blockKey,
      ),
    };
  }
  return out;
}

/**
 * The blocks a rename of `from` to `to` writes, in one change: the kind's
 * block with the entry renamed in place, and every block whose rule names
 * `from` (saved rules included) with that rule naming `to`. `null` when
 * nothing can be renamed: the block conflicts, `from` isn't saved, `to` is
 * empty or taken, or `from` is a running A/B test (its name is locked:
 * visitors are grouped by it). A block that reads the whole map in its own code isn't
 * rewritten (`wholeBlock` lists them, for the editor to point out).
 */
export function planNamedRuleRename(
  decofile: Record<string, unknown>,
  kind: NamedRuleKind,
  from: string,
  to: string,
  meta?: LiveMeta | null,
): { writes: Record<string, Record<string, unknown>> } | null {
  const read = readNamedRuleBlock(decofile, kind);
  if (read.kind !== "saved") return null;
  if (!to.trim() || from === to) return null;
  if (!Object.hasOwn(read.values, from) || Object.hasOwn(read.block, to)) {
    return null;
  }
  if (
    kind === "experiments" &&
    !canRenameExperiment(read.values[from] as number)
  ) {
    return null;
  }
  const { blockKey } = namedRuleKindInfo(kind);
  const writes: Record<string, Record<string, unknown>> = {
    [blockKey]: withRenamedNamedRuleEntry(read.block, from, to),
  };
  const uses = findRuleReferences(decofile, meta)[kind].byName.get(from) ?? [];
  for (const use of uses) {
    // A use through a saved rule is rewritten where the rule itself is.
    if (use.via.length > 0) continue;
    const current = writes[use.blockKey] ?? decofile[use.blockKey];
    if (!isRecord(current)) continue;
    writes[use.blockKey] = replaceAt(current, use.path, namedRule(kind, to));
  }
  return { writes };
}

/**
 * A copy of `root` with the object at `path` merged with `value` (keeping
 * its other fields), every container on the way copied, `root` untouched.
 */
function replaceAt(
  root: Record<string, unknown>,
  path: BlockPath,
  value: Record<string, unknown>,
): Record<string, unknown> {
  const merge = (node: unknown, depth: number): unknown => {
    if (depth === path.length) {
      return isRecord(node) ? { ...node, ...value } : node;
    }
    const key = path[depth]!;
    if (Array.isArray(node) && typeof key === "number") {
      const copy = node.slice();
      copy[key] = merge(node[key], depth + 1);
      return copy;
    }
    if (isRecord(node) && typeof key === "string") {
      return { ...node, [key]: merge(node[key], depth + 1) };
    }
    return node;
  };
  return merge(root, 0) as Record<string, unknown>;
}

/**
 * The published content, from the draft's and both sides of its changes
 * (`changes.get`): each changed block as it was before (absent when it is
 * new). A change whose sides weren't read, or whose published side couldn't
 * be read (no `before` though the base has a version), keeps the draft's
 * copy.
 */
export function publishedDecofile(
  draft: Record<string, unknown>,
  sides: Record<string, ChangeDetail>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...draft };
  for (const [blockKey, side] of Object.entries(sides)) {
    if (side.kind === null) continue;
    if (side.before !== null) out[blockKey] = side.before;
    else if (side.baseVersion === null) delete out[blockKey];
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
