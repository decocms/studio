/**
 * The edits the Experiments tab and the Campaigns view make to the
 * `experiments` and `campaigns` blocks (named-rules.ts), as changes for one
 * guarded `blocks.apply` into the draft (use-apply-named-rule.ts). Pure, so
 * the views and the tests share them. Nothing here writes a published site:
 * every change goes live with the normal Publish.
 */

import {
  type CampaignWindow,
  NAMED_RULE_KINDS,
  type NamedRuleKind,
  namedRuleKindInfo,
  readNamedRuleBlock,
  withNamedRuleEntry,
  withoutNamedRuleEntry,
} from "./named-rules";
import { newNameProblem, type NewNameProblem } from "./named-rule-picker";
import {
  findRuleReferences,
  findSavedMatcherReferences,
} from "./rule-references";
import { isSavedMatcherBlockReference } from "./matcher-rules";
import type { LiveMeta } from "./resolve-schema";
import type { NamedRuleChange } from "./use-apply-named-rule";

type ValueOf<K extends NamedRuleKind> = K extends "experiments"
  ? number
  : CampaignWindow;

/**
 * The change that sets `name` to `value` (a new name is added last, every
 * other name kept as saved). `null` when the block holds something else: it
 * is never written over.
 */
export function planNamedRuleSet<K extends NamedRuleKind>(
  decofile: Record<string, unknown>,
  kind: K,
  name: string,
  value: ValueOf<K>,
): NamedRuleChange | null {
  const read = readNamedRuleBlock(decofile, kind);
  if (read.kind === "conflict") return null;
  return {
    writes: {
      [namedRuleKindInfo(kind).blockKey]: withNamedRuleEntry(
        read.block,
        kind,
        name,
        value as never,
      ),
    },
  };
}

/**
 * The change that adds a new name. `problem` when the name can't be used
 * (empty, taken, reserved) or the block holds something else.
 */
export function planNamedRuleCreate<K extends NamedRuleKind>(
  decofile: Record<string, unknown>,
  kind: K,
  name: string,
  value: ValueOf<K>,
): { change: NamedRuleChange } | { problem: NewNameProblem | "conflict" } {
  const read = readNamedRuleBlock(decofile, kind);
  if (read.kind === "conflict") return { problem: "conflict" };
  const existing = Object.keys(read.block).filter(
    (key) => key !== "__resolveType",
  );
  const problem = newNameProblem(name, existing);
  if (problem) return { problem };
  return { change: planNamedRuleSet(decofile, kind, name.trim(), value)! };
}

/**
 * The change that removes `name` from the block. A name that a rule still
 * uses can't be removed (the editor first takes the test or campaign off
 * those pages): `null` then, and when there's nothing to remove.
 */
export function planNamedRuleDelete(
  decofile: Record<string, unknown>,
  kind: NamedRuleKind,
  name: string,
): NamedRuleChange | null {
  const read = readNamedRuleBlock(decofile, kind);
  if (read.kind !== "saved" || !Object.hasOwn(read.block, name)) return null;
  const change = {
    writes: {
      [namedRuleKindInfo(kind).blockKey]: withoutNamedRuleEntry(
        read.block,
        name,
      ),
    },
  };
  return namedRulesLeftInUse(decofile, change).length > 0 ? null : change;
}

/**
 * Undo of a delete: the change that puts back only `name`, with the value it
 * had (`raw`, as stored), onto the block as it is now, so a test or campaign
 * created since stays. `null` when the name is back already (nothing to
 * undo) or the block holds something else.
 */
export function planNamedRuleRestore(
  decofile: Record<string, unknown>,
  kind: NamedRuleKind,
  name: string,
  raw: unknown,
): NamedRuleChange | null {
  if (raw === undefined) return null;
  const read = readNamedRuleBlock(decofile, kind);
  if (read.kind === "conflict" || Object.hasOwn(read.block, name)) return null;
  return {
    writes: {
      [namedRuleKindInfo(kind).blockKey]: withNamedRuleEntry(
        read.block,
        kind,
        name,
        raw as never,
      ),
    },
  };
}

/**
 * The change that removes the saved rule `blockKey`, only while nothing uses
 * it (no page, section or other saved rule refers to it): `null` otherwise.
 */
export function planSavedRuleRemove(
  decofile: Record<string, unknown>,
  blockKey: string,
  meta?: LiveMeta | null,
): NamedRuleChange | null {
  if (
    !isSavedMatcherBlockReference({ __resolveType: blockKey }, decofile, meta)
  ) {
    return null;
  }
  if (findSavedMatcherReferences(decofile, blockKey, meta).length > 0) {
    return null;
  }
  return { writes: {}, deletes: [blockKey] };
}

/**
 * The tests and campaigns a change would remove while a rule (a page's or a
 * section's variant, a saved rule) still names them once it lands. Studio
 * never sends such a change: the names must leave the pages first. A rename
 * rewrites every rule in the same change, so it removes none in use. Only
 * rules by name count; a section that reads the whole map just reads a
 * missing name as false.
 */
export function namedRulesLeftInUse(
  decofile: Record<string, unknown>,
  change: Pick<NamedRuleChange, "writes" | "deletes">,
): Array<{ kind: NamedRuleKind; name: string }> {
  const removed: Array<{ kind: NamedRuleKind; name: string }> = [];
  for (const kind of NAMED_RULE_KINDS) {
    const { blockKey } = namedRuleKindInfo(kind);
    const written = Object.hasOwn(change.writes, blockKey);
    const deleted = !written && (change.deletes ?? []).includes(blockKey);
    if (!written && !deleted) continue;
    const before = readNamedRuleBlock(decofile, kind);
    if (before.kind !== "saved") continue;
    const after = written ? change.writes[blockKey]! : {};
    for (const name of Object.keys(before.block)) {
      if (name === "__resolveType" || Object.hasOwn(after, name)) continue;
      removed.push({ kind, name });
    }
  }
  if (removed.length === 0) return [];
  const next: Record<string, unknown> = { ...decofile, ...change.writes };
  for (const key of change.deletes ?? []) {
    if (!Object.hasOwn(change.writes, key)) delete next[key];
  }
  const refs = findRuleReferences(next);
  return removed.filter(
    ({ kind, name }) => (refs[kind].byName.get(name) ?? []).length > 0,
  );
}

/**
 * How a name in the draft compares with the published site:
 *
 * - `new`: published content doesn't have it yet;
 * - `changed`: it's there with another share or window;
 * - `published`: the same.
 *
 * `null` while the published content isn't known.
 */
export type NamedRuleEntryState = "new" | "changed" | "published";

export function namedRuleEntryState(
  published: Record<string, unknown> | null,
  kind: NamedRuleKind,
  name: string,
  value: number | CampaignWindow,
): NamedRuleEntryState | null {
  if (!published) return null;
  const read = readNamedRuleBlock(published, kind);
  if (read.kind !== "saved" || !Object.hasOwn(read.values, name)) return "new";
  return sameValue(read.values[name]!, value) ? "published" : "changed";
}

/** The published share or window of `name`, if it has one. */
export function publishedNamedRuleValue<K extends NamedRuleKind>(
  published: Record<string, unknown> | null,
  kind: K,
  name: string,
): ValueOf<K> | undefined {
  if (!published) return undefined;
  const read = readNamedRuleBlock(published, kind);
  if (read.kind !== "saved") return undefined;
  return read.values[name] as ValueOf<K> | undefined;
}

/**
 * The names the published site has that the draft removed: they stop at the
 * next Publish.
 */
export function namedRulesRemovedInDraft(
  decofile: Record<string, unknown>,
  published: Record<string, unknown> | null,
  kind: NamedRuleKind,
): string[] {
  if (!published) return [];
  const live = readNamedRuleBlock(published, kind);
  if (live.kind !== "saved") return [];
  const draft = readNamedRuleBlock(decofile, kind);
  const kept = draft.kind === "conflict" ? {} : draft.values;
  return Object.keys(live.values).filter((name) => !Object.hasOwn(kept, name));
}

function sameValue(
  a: number | CampaignWindow,
  b: number | CampaignWindow,
): boolean {
  if (typeof a === "number" || typeof b === "number") return a === b;
  return sameMoment(a.start, b.start) && sameMoment(a.end, b.end);
}

function sameMoment(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a === b || new Date(a).getTime() === new Date(b).getTime();
}
