/**
 * Discarding changes (the publish dialog, the local changes dialog) keeps the
 * rule of the Experiments tab and the Campaigns view: a test or campaign a
 * page uses never goes away. A discard puts entries back as the base has
 * them, so it can take a name out of the `experiments` or `campaigns` block
 * while the draft's pages still use it, or bring back a page whose variant
 * uses a name the draft deleted. Either way the discard waits, and the
 * dialog lists the pages. Pure: the hook and the tests share it.
 */

import type { ChangeDetail } from "@decocms/blocks/protocol";
import {
  type NamedRuleUseRow,
  namedRuleBlockingRows,
  namedRuleUses,
} from "./named-rule-uses";
import {
  NAMED_RULE_KINDS,
  type NamedRuleKind,
  readNamedRuleBlock,
} from "./named-rules";
import type { LiveMeta } from "./resolve-schema";
import { findRuleReferences, publishedDecofile } from "./rule-references";

export interface NamedRuleDiscardBreak {
  kind: NamedRuleKind;
  name: string;
  /**
   * `removes`: the discard takes the name away while pages still use it.
   * `returns`: it brings back a use of a name the draft deleted.
   */
  cause: "removes" | "returns";
  /** The blocks that would name it, as "Used by" lists them. */
  rows: NamedRuleUseRow[];
}

/** `kind:name` of every name a rule uses that its block doesn't have. */
function missingNames(
  decofile: Record<string, unknown>,
  meta?: LiveMeta | null,
): Set<string> {
  const refs = findRuleReferences(decofile, meta);
  const missing = new Set<string>();
  for (const kind of NAMED_RULE_KINDS) {
    const read = readNamedRuleBlock(decofile, kind);
    if (read.kind === "conflict") continue;
    for (const name of refs[kind].byName.keys()) {
      if (!Object.hasOwn(read.block, name)) missing.add(`${kind}:${name}`);
    }
  }
  return missing;
}

/**
 * What discarding `names` would leave pointing at a test or campaign that
 * doesn't exist, given the draft and both sides of those changes
 * (`changes.get`). Names already missing in the draft aren't the discard's
 * doing and don't count. Empty: the discard is safe.
 */
export function namedRuleDiscardBreaks(input: {
  draft: Record<string, unknown>;
  sides: Record<string, ChangeDetail>;
  names: readonly string[];
  meta?: LiveMeta | null;
}): NamedRuleDiscardBreak[] {
  const { draft, meta } = input;
  const discarded: Record<string, ChangeDetail> = {};
  for (const name of input.names) {
    const side = input.sides[name];
    if (side) discarded[name] = side;
  }
  const after = publishedDecofile(draft, discarded);
  const before = missingNames(draft, meta);
  const missing = [...missingNames(after, meta)].filter(
    (key) => !before.has(key),
  );
  if (missing.length === 0) return [];
  const uses = namedRuleUses({
    decofile: after,
    meta,
    changeCount: 0,
    sides: undefined,
  });
  return missing.map((key) => {
    const at = key.indexOf(":");
    const kind = key.slice(0, at) as NamedRuleKind;
    const name = key.slice(at + 1);
    const inDraft = readNamedRuleBlock(draft, kind);
    return {
      kind,
      name,
      cause:
        inDraft.kind === "saved" && Object.hasOwn(inDraft.block, name)
          ? "removes"
          : "returns",
      rows: namedRuleBlockingRows(uses, kind, name, after, meta),
    };
  });
}
