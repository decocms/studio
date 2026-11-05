/**
 * The Publish review's flag on a page or section whose rules name an A/B
 * test or a campaign that isn't there (rule-references.ts): deleted,
 * discarded, removed in another tab, never created or typed by hand. Nothing
 * is blocked for them; Studio counts and lists no uses (`deco check` reports
 * a rule that names a missing test or campaign). Pure: the Publish review and
 * the tests share it.
 */

import {
  NAMED_RULE_KINDS,
  namedRuleExists,
  type NamedRuleKind,
  namedRuleSupport,
  readNamedRuleBlock,
} from "./named-rules";
import { findRuleReferences } from "./rule-references";
import type { LiveMeta } from "./resolve-schema";

/**
 * Results by the identity of their inputs: the draft and the schema are the
 * query cache's objects, which stay the same until they change, so a Publish
 * review that renders again reads the result it already has instead of
 * walking the whole draft again. Held weakly: a draft no one holds any more
 * drops its results.
 */
const FLAGS = new WeakMap<
  object,
  WeakMap<object, Map<string, NamedRuleKind[]>>
>();
/** The flags of a draft read with no schema object. */
const NO_META = {};

/**
 * The blocks whose rules use a name of `kind` that doesn't exist
 * (`namedRuleExists`: not in its `experiments` or `campaigns` block, or with
 * a value Studio can't read), saved rules and the blocks using them included.
 */
function missingNamedRuleUsers(
  decofile: Record<string, unknown>,
  meta: LiveMeta | null | undefined,
  kind: NamedRuleKind,
): string[] {
  const read = readNamedRuleBlock(decofile, kind);
  if (read.kind === "conflict") return [];
  const users = new Set<string>();
  for (const [name, refs] of findRuleReferences(decofile, meta)[kind]) {
    if (namedRuleExists(read, name)) continue;
    for (const ref of refs) users.add(ref.blockKey);
  }
  return [...users];
}

/**
 * Per block, the kinds whose names its rules use but that don't exist, for
 * the kinds the site's schema has built in. The Publish review flags those
 * cards; nothing is blocked.
 */
export function blocksUsingMissingNamedRules(
  decofile: Record<string, unknown>,
  meta: LiveMeta | null | undefined,
): Map<string, NamedRuleKind[]> {
  const metaKey = meta ?? NO_META;
  let byMeta = FLAGS.get(decofile);
  if (!byMeta) {
    byMeta = new WeakMap();
    FLAGS.set(decofile, byMeta);
  }
  const cached = byMeta.get(metaKey);
  if (cached) return cached;
  const out = new Map<string, NamedRuleKind[]>();
  for (const kind of NAMED_RULE_KINDS) {
    if (namedRuleSupport(meta, kind) !== "available") continue;
    for (const blockKey of missingNamedRuleUsers(decofile, meta, kind)) {
      const list = out.get(blockKey) ?? [];
      if (!list.includes(kind)) list.push(kind);
      out.set(blockKey, list);
    }
  }
  byMeta.set(metaKey, out);
  return out;
}
