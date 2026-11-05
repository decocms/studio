/**
 * The bodies the Experiments tab and the Calendar (campaigns) view load on a
 * hosted draft (design: Studio's "Used by" counts and rename/delete rewrites
 * read the index, not every body). The index's `meta.rules` names the tests
 * and campaigns each body uses (one list for both kinds) and `meta.refs` the
 * saved blocks it references, so the views count uses over index stubs
 * (rule-references.ts) and load only:
 *
 * - the `experiments` and `campaigns` blocks themselves;
 * - the users of a name neither block holds (a test or campaign that isn't
 *   there: which kind a stub's name is can only be read from its body);
 * - an opened name's users, for its "Used by" rows (the variant and section
 *   of each use), with the sections that read its kind's whole map;
 * - before a rename or delete, the users of that name
 *   (use-apply-named-rule.ts).
 *
 * A use through a saved rule (a saved matcher block whose rule names it)
 * reaches the blocks that reference that rule, so those are loaded with it.
 */

import {
  type ContentIndex,
  indexReferrers,
  indexRuleUsers,
  isIndexStub,
} from "./hosted-content";
import { isSavedMatcherBlockReference } from "./matcher-rules";
import {
  NAMED_RULE_KINDS,
  type NamedRuleKind,
  namedRuleKindInfo,
  namedRuleNames,
  readNamedRuleBlock,
} from "./named-rules";
import type { LiveMeta } from "./resolve-schema";

/** The blocks that hold the tests and the campaigns. */
export const NAMED_RULE_BLOCKS: readonly string[] = NAMED_RULE_KINDS.map(
  (kind) => namedRuleKindInfo(kind).blockKey,
);

/**
 * The blocks whose bodies use one of `rules` (the index's `meta.rules`),
 * plus, through each saved rule among them (and saved rules that use that
 * one in turn), the blocks that reference it. Index order, each once.
 */
function namedRuleUserNames(
  index: ContentIndex | undefined,
  listing: Record<string, unknown>,
  meta: LiveMeta | null | undefined,
  rules: Iterable<string>,
): string[] {
  const users = indexRuleUsers(index, rules);
  const out = new Set(users);
  const isSavedRule = (name: string) =>
    isSavedMatcherBlockReference({ __resolveType: name }, listing, meta);
  const followed = new Set<string>();
  let rulesNow = users.filter(isSavedRule);
  while (rulesNow.length > 0) {
    for (const rule of rulesNow) followed.add(rule);
    const next: string[] = [];
    for (const user of indexReferrers(index, rulesNow)) {
      out.add(user);
      if (!followed.has(user) && isSavedRule(user)) next.push(user);
    }
    rulesNow = next;
  }
  return [...out];
}

/**
 * What the views load before they show: both kinds' blocks, then (once
 * those are loaded) the users of every name the index's rules carry that
 * neither block holds.
 */
export function namedRuleViewNames(
  index: ContentIndex | undefined,
  listing: Record<string, unknown> | undefined,
  meta: LiveMeta | null | undefined,
): string[] {
  if (!index || !listing) return [...NAMED_RULE_BLOCKS];
  const held = new Set<string>();
  for (const kind of NAMED_RULE_KINDS) {
    if (isIndexStub(listing[namedRuleKindInfo(kind).blockKey])) {
      return [...NAMED_RULE_BLOCKS];
    }
    const read = readNamedRuleBlock(listing, kind);
    // The view says the block clashes; nothing to count.
    if (read.kind === "conflict") return [...NAMED_RULE_BLOCKS];
    for (const name of namedRuleNames(read)) held.add(name);
  }
  const unheld = new Set<string>();
  for (const entry of Object.values(index.entries)) {
    for (const rule of entry.meta?.rules ?? []) {
      if (!held.has(rule)) unheld.add(rule);
    }
  }
  return [
    ...NAMED_RULE_BLOCKS,
    ...namedRuleUserNames(index, listing, meta, unheld),
  ];
}

/**
 * What an opened name's "Used by" loads: its users, and the sections that
 * read its kind's whole map.
 */
export function namedRuleDetailNames(
  index: ContentIndex | undefined,
  listing: Record<string, unknown>,
  meta: LiveMeta | null | undefined,
  kind: NamedRuleKind,
  name: string,
): string[] {
  return [
    ...new Set([
      ...namedRuleUserNames(index, listing, meta, [name]),
      ...indexReferrers(index, [namedRuleKindInfo(kind).blockKey]),
    ]),
  ];
}
