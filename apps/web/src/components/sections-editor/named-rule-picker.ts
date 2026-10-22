import { translate } from "@/i18n/use-t.ts";
import { formatCampaignWindow } from "./format-matcher";
import {
  type CampaignWindow,
  isInlineDateRule,
  namedRule,
  namedRuleKindInfo,
  namedRuleOf,
  namedRuleSupport,
  type NamedRuleKind,
  NAMED_RULE_KINDS,
  namedRuleExists,
  readNamedRuleBlock,
  withNamedRuleEntry,
} from "./named-rules";
import type { LiveMeta } from "./resolve-schema";

/**
 * The rule picker's "A/B test" and "Date" items on a Blocks (v8) site
 * (named-rules.ts): pick a test or campaign by name, or create one right
 * there. Creating writes the `experiments`/`campaigns` block and the rule in
 * one guarded save to the draft (use-apply-named-rule.ts). Pure: the picker,
 * the editor and the tests share it.
 */

/** One existing name, as the picker lists it. */
export interface NamedRuleEntry {
  name: string;
  /** "50% of visitors", "Nov 27 – Dec 1", or "" when there's nothing to add. */
  summary: string;
}

/** What the picker offers for one kind. */
export interface NamedRulePickerKind {
  kind: NamedRuleKind;
  /**
   * `absent`: no block yet, the first create makes it. `saved`: names to
   * pick. `conflict`: a block of that name holds something else; nothing is
   * offered and the step explains.
   */
  state: "absent" | "saved" | "conflict";
  entries: NamedRuleEntry[];
}

/**
 * The kinds the picker offers: those the site's schema has as built-ins
 * (`namedRuleSupport` is `available`). A v7 site, or a v8 one on an older
 * `@decocms/blocks`, gets none and keeps today's picker.
 */
export function namedRulePickerKinds(
  meta: Pick<LiveMeta, "manifest"> | null | undefined,
  decofile: Record<string, unknown>,
): NamedRulePickerKind[] {
  const kinds: NamedRulePickerKind[] = [];
  for (const kind of NAMED_RULE_KINDS) {
    if (namedRuleSupport(meta, kind) !== "available") continue;
    const block = readNamedRuleBlock(decofile, kind);
    if (block.kind === "conflict") {
      kinds.push({ kind, state: "conflict", entries: [] });
      continue;
    }
    // Only names that exist (`namedRuleExists`): readable values.
    const entries = Object.entries(block.values).map(([name, value]) => ({
      name,
      summary: namedRuleSummary(kind, value),
    }));
    kinds.push({ kind, state: block.kind, entries });
  }
  return kinds;
}

/** The short description of a test's share or a campaign's dates. */
function namedRuleSummary(
  kind: NamedRuleKind,
  value: number | CampaignWindow | undefined,
): string {
  if (value === undefined) return "";
  if (kind === "experiments") {
    return typeof value === "number"
      ? translate("sectionsEditor.namedRulePicker.shareOfVisitors", {
          share: String(value),
        })
      : "";
  }
  return typeof value === "object" ? (formatCampaignWindow(value) ?? "") : "";
}

/** The matchers the named items stand in for, hidden from the plain list. */
export function namedRuleMatchers(kinds: NamedRulePickerKind[]): Set<string> {
  return new Set(kinds.map((k) => namedRuleKindInfo(k.kind).matcher));
}

/** Why a new name can't be used, if it can't. */
export type NewNameProblem = "empty" | "taken" | "reserved";

export function newNameProblem(
  name: string,
  existing: readonly string[],
): NewNameProblem | null {
  const trimmed = name.trim();
  if (!trimmed) return "empty";
  // `__resolveType` and other `__` keys belong to the block format.
  if (trimmed.startsWith("__")) return "reserved";
  if (existing.includes(trimmed)) return "taken";
  return null;
}

/** A share typed by the editor: a whole number from 0 to 100, or nothing. */
export function parseShareInput(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d{1,3}$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value >= 0 && value <= 100 ? value : null;
}

const pad = (n: number) => String(Math.abs(n)).padStart(2, "0");

/**
 * A `datetime-local` value ("2026-11-27T00:00") as an ISO date-time with the
 * offset the editor's clock has on that day ("2026-11-27T00:00:00-03:00"),
 * the shape a campaign is saved in. `null` for an empty or unreadable value.
 */
export function localInputToIso(local: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(
    local.trim(),
  );
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;
  const date = new Date(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s ?? 0),
  );
  if (Number.isNaN(date.getTime())) return null;
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const zone = `${sign}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`;
  return `${y}-${mo}-${d}T${h}:${mi}:${s ?? "00"}${zone}`;
}

/** An ISO date-time as a `datetime-local` value in the editor's clock. */
export function isoToLocalInput(iso: string | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * A campaign's window from the two inputs. A cleared input is no bound (left
 * out, never saved as ""). `end-before-start` when both are set and the end
 * isn't after the start, as `deco check` warns.
 */
export function windowFromInputs(
  startLocal: string,
  endLocal: string,
): { window: CampaignWindow } | { problem: "end-before-start" } {
  const start = localInputToIso(startLocal);
  const end = localInputToIso(endLocal);
  if (start && end && new Date(end).getTime() <= new Date(start).getTime()) {
    return { problem: "end-before-start" };
  }
  return {
    window: { ...(start ? { start } : {}), ...(end ? { end } : {}) },
  };
}

/**
 * The window an inline `date { start, end }` rule (from before campaigns)
 * carries, so creating a campaign from it starts with its dates.
 */
export function inlineDateWindow(rule: unknown): CampaignWindow | null {
  if (!isInlineDateRule(rule)) return null;
  const { start, end } = rule as { start?: unknown; end?: unknown };
  return {
    ...(typeof start === "string" && start ? { start } : {}),
    ...(typeof end === "string" && end ? { end } : {}),
  };
}

/** A choice made in the picker: an existing name, or a new one with its value. */
export type NamedRulePick =
  | { kind: "experiments"; name: string; create?: { share: number } }
  | { kind: "campaigns"; name: string; create?: { window: CampaignWindow } };

/**
 * What a pick writes: the rule, and the block with the new name when the pick
 * creates one. `conflict` when the block holds something else (nothing is
 * written over it). A name created meanwhile is used as it is, never
 * replaced; one whose value Studio can't read (`namedRuleExists`) gets the
 * new value.
 */
export function planNamedRulePick(
  decofile: Record<string, unknown>,
  pick: NamedRulePick,
):
  | {
      ok: true;
      rule: Record<string, unknown>;
      blockWrite: { blockKey: string; block: Record<string, unknown> } | null;
    }
  | { ok: false; reason: "conflict" | "empty" } {
  const name = pick.name.trim();
  if (!name || name.startsWith("__")) return { ok: false, reason: "empty" };
  const rule = namedRule(pick.kind, name);
  if (!pick.create) return { ok: true, rule, blockWrite: null };
  const block = readNamedRuleBlock(decofile, pick.kind);
  if (block.kind === "conflict") return { ok: false, reason: "conflict" };
  if (namedRuleExists(block, name)) {
    return { ok: true, rule, blockWrite: null };
  }
  const value =
    pick.kind === "experiments" ? pick.create.share : pick.create.window;
  return {
    ok: true,
    rule,
    blockWrite: {
      blockKey: namedRuleKindInfo(pick.kind).blockKey,
      block: withNamedRuleEntry(block.block, pick.kind, name, value),
    },
  };
}

/** The test or campaign a variant's rule names, when it names one. */
export function currentNamedRule(
  rule: unknown,
  kinds: NamedRulePickerKind[],
): { kind: NamedRuleKind; name: string; entry: NamedRuleEntry | null } | null {
  const named = namedRuleOf(rule);
  if (!named || !kinds.some((k) => k.kind === named.kind)) return null;
  const kind = kinds.find((k) => k.kind === named.kind)!;
  return {
    ...named,
    entry: kind.entries.find((e) => e.name === named.name) ?? null,
  };
}

/** What the rule editor shows under the picker for a named or inline-date rule. */
export interface NamedRuleRowState {
  kind: NamedRuleKind;
  name: string;
  summary: string;
  /**
   * The rule names something the block doesn't have. Never with `conflict`:
   * a block that holds something else has its own explanation.
   */
  missing: boolean;
  /**
   * The kind's block holds something else (the picker's `conflict`), also
   * for an inline-date rule, since no campaign can be picked or created.
   */
  conflict: boolean;
  /** A `date { start, end }` rule from before campaigns. */
  inlineDate: boolean;
}

/**
 * The locked row for a variant's rule, when the picker offers its kind: a
 * named test or campaign, or an inline date rule to move into a campaign.
 * `null` for any other rule, which keeps its usual form.
 */
export function namedRuleRowState(
  rule: unknown,
  kinds: NamedRulePickerKind[],
): NamedRuleRowState | null {
  const current = currentNamedRule(rule, kinds);
  if (current) {
    const conflict = kinds.some(
      (k) => k.kind === current.kind && k.state === "conflict",
    );
    return {
      kind: current.kind,
      name: current.name,
      summary: current.entry?.summary ?? "",
      missing: current.entry === null && !conflict,
      conflict,
      inlineDate: false,
    };
  }
  if (isInlineDateRule(rule) && kinds.some((k) => k.kind === "campaigns")) {
    return {
      kind: "campaigns",
      name: "",
      summary: "",
      missing: false,
      conflict: kinds.some(
        (k) => k.kind === "campaigns" && k.state === "conflict",
      ),
      inlineDate: true,
    };
  }
  return null;
}

/**
 * The kind of a test or campaign that a rule names somewhere inside it but
 * the picker doesn't have: inside a `multi`, a `lazy` value or a saved rule
 * the rule refers to (at any depth). The editor shows those rules with their
 * own form, so it says so under the form; nothing is blocked. `null` when
 * every name exists, and for a rule the locked row already covers.
 */
export function missingNamedRuleWithin(
  rule: unknown,
  kinds: NamedRulePickerKind[],
  decofile: Record<string, unknown> | undefined,
): NamedRuleKind | null {
  if (kinds.length === 0 || namedRuleOf(rule)) return null;
  // A kind whose block holds something else has its own explanation.
  const missing = (kind: NamedRuleKind, name: string) => {
    const offered = kinds.find((k) => k.kind === kind);
    return (
      !!offered &&
      offered.state !== "conflict" &&
      !offered.entries.some((e) => e.name === name)
    );
  };
  const followed = new Set<string>();
  const stack: unknown[] = [rule];
  while (stack.length > 0) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      stack.push(...node);
      continue;
    }
    if (!node || typeof node !== "object") continue;
    const named = namedRuleOf(node);
    if (named) {
      if (missing(named.kind, named.name)) return named.kind;
      continue;
    }
    const record = node as Record<string, unknown>;
    const ref = record.__resolveType;
    // A saved rule, read from the draft (a cycle stops at one seen before).
    if (
      typeof ref === "string" &&
      decofile &&
      Object.hasOwn(decofile, ref) &&
      !followed.has(ref)
    ) {
      followed.add(ref);
      stack.push(decofile[ref]);
    }
    for (const [key, value] of Object.entries(record)) {
      if (key !== "__resolveType") stack.push(value);
    }
  }
  return null;
}

/**
 * The kind a field's value points at as a whole: `{ "__resolveType":
 * "experiments" }` or `"campaigns"`, nothing else in it.
 */
export function namedRuleBlockFieldValue(value: unknown): NamedRuleKind | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "__resolveType") return null;
  const target = (value as { __resolveType?: unknown }).__resolveType;
  return (
    NAMED_RULE_KINDS.find(
      (kind) => namedRuleKindInfo(kind).blockKey === target,
    ) ?? null
  );
}

/**
 * The kinds a field can read as a whole: the schema lists the kind's
 * built-in type among the blocks that fit it (`split-traffic`,
 * `calendar`), and the picker offers the kind. Empty when the field's
 * value is something else (a plain map, another block), which keeps its
 * usual form.
 */
export function namedRuleBlockFieldKinds(
  schema: { type?: string; anyOfRefs?: Array<{ resolveType: string }> },
  value: unknown,
  kinds: NamedRulePickerKind[],
): NamedRuleKind[] {
  if (schema.type !== "block-ref" || !schema.anyOfRefs?.length) return [];
  const empty =
    value === undefined ||
    value === null ||
    (typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length === 0);
  if (!empty && namedRuleBlockFieldValue(value) === null) return [];
  const fits = new Set(schema.anyOfRefs.map((ref) => ref.resolveType));
  return kinds
    .map((k) => k.kind)
    .filter((kind) => fits.has(namedRuleKindInfo(kind).resolveType));
}
