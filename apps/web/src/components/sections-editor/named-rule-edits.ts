/**
 * The edits the Experiments tab and the Campaigns view make to the
 * `experiments` and `campaigns` blocks (named-rules.ts), as changes for one
 * guarded `blocks.apply` into the draft (use-apply-named-rule.ts). Pure, so
 * the views and the tests share them. Nothing here writes a published site:
 * every change goes live with the normal Publish.
 */

import {
  type CampaignWindow,
  type NamedRuleKind,
  namedRuleKindInfo,
  readNamedRuleBlock,
  withNamedRuleEntry,
  withoutNamedRuleEntry,
} from "./named-rules";
import { newNameProblem, type NewNameProblem } from "./named-rule-picker";
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
 * The change that removes `name` from the block. The rules that name it stay
 * as they are: their variants stop showing until they name another one, and
 * creating the name again brings them back. `null` when there's nothing to
 * remove.
 */
export function planNamedRuleDelete(
  decofile: Record<string, unknown>,
  kind: NamedRuleKind,
  name: string,
): NamedRuleChange | null {
  const read = readNamedRuleBlock(decofile, kind);
  if (read.kind !== "saved" || !Object.hasOwn(read.block, name)) return null;
  return {
    writes: {
      [namedRuleKindInfo(kind).blockKey]: withoutNamedRuleEntry(
        read.block,
        name,
      ),
    },
  };
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
