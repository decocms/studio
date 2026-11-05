/**
 * Where a decofile uses its rules: the saved matcher blocks a rule points at
 * (what keeps a saved rule from being cleaned up as unused), and the named
 * rules (an A/B test's or a campaign's name, named-rules.ts) each block's
 * rules name (what the Publish review checks against the `experiments` and
 * `campaigns` blocks, named-rule-uses.ts).
 *
 * On a hosted draft the decofile is a listing (hosted-content.ts): a block
 * not loaded is an index stub. Its index `refs` say whether it references a
 * saved rule; the names its rules use are only read from a loaded body.
 */

import { indexStubRefs, isIndexStub } from "./hosted-content";
import { isSavedMatcherBlockReference } from "./matcher-rules";
import { type NamedRuleKind, namedRuleOf } from "./named-rules";
import type { LiveMeta } from "./resolve-schema";

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
): BlockLocation[] {
  if (!blockKey) return [];
  const found: BlockLocation[] = [];
  const isSavedRule = () =>
    isSavedMatcherBlockReference({ __resolveType: blockKey }, decofile, meta);
  forEachDecofileObject(decofile, blockKey, (node, at) => {
    if (at.parent === null && isIndexStub(node)) {
      // A block not loaded: its index refs say whether it uses the rule.
      if (indexStubRefs(node).includes(blockKey) && isSavedRule()) {
        found.push(locationOf(at));
      }
      return;
    }
    if (node.__resolveType !== blockKey) return;
    if (!isSavedMatcherBlockReference(node, decofile, meta)) return;
    found.push(locationOf(at));
  });
  return found;
}

/** One block whose rules name an A/B test or a campaign. */
export interface RuleReference {
  kind: NamedRuleKind;
  name: string;
  /** The block that uses it. */
  blockKey: string;
  /**
   * Saved matcher blocks the rule is reached through, nearest to `blockKey`
   * first: `[]` when the block uses the named rule itself.
   */
  via: string[];
  /** `blockKey` is itself a saved matcher block (a saved rule). */
  savedRule: boolean;
}

/** Per kind, per name, the blocks whose rules name it. */
export type RuleReferences = Record<
  NamedRuleKind,
  Map<string, RuleReference[]>
>;

/**
 * Every block whose rules name an A/B test or a campaign: a rule
 * `experiment { name }` or `campaign { name }` anywhere (a variant's rule in
 * a v8 `multivariate` or a v7 variants flag, inside a `multi`, inside a
 * `lazy` value), whether or not the `experiments`/`campaigns` block has the
 * name. Content isn't meant to keep such a rule in a saved rule block, but
 * older content may: a block whose rule references a saved matcher block
 * that uses the name (at any depth of saved rules) counts as using it, and
 * so does the saved rule. A `date` rule with its own dates names no
 * campaign and isn't listed. A block not loaded (an index stub) names none.
 */
export function findRuleReferences(
  decofile: Record<string, unknown>,
  meta?: LiveMeta | null,
): RuleReferences {
  const hits: Array<{ kind: NamedRuleKind; name: string; blockKey: string }> =
    [];
  const out: RuleReferences = { experiments: new Map(), campaigns: new Map() };
  forEachDecofileObject(decofile, null, (node, at) => {
    if (at.parent === null && isIndexStub(node)) return;
    const named = namedRuleOf(node);
    if (named) hits.push({ ...named, blockKey: at.blockKey });
  });

  const add = (ref: RuleReference) => {
    const list = out[ref.kind].get(ref.name);
    if (list) list.push(ref);
    else out[ref.kind].set(ref.name, [ref]);
  };
  const usesOfSavedRule = new Map<string, BlockLocation[]>();
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
    const { blockKey } = hit;
    const savedRule = isSavedRule(blockKey);
    add({ ...hit, via: [], savedRule });
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
