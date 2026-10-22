import { isV8Schema } from "@decocms/shared/blocks-major";
import type { LiveMeta } from "./resolve-schema";

/**
 * Named rules of a Blocks (v8) site: A/B tests and campaigns, kept as content.
 * Each kind is one well-known saved block of a built-in type that maps a name
 * to its setting, and one built-in rule that names an entry of that block
 * (`@decocms/blocks` `builtins/experiments.ts` and `builtins/campaigns.ts`):
 *
 * - `experiments` (type `split-traffic`): name → whole percentage of visitors
 *   in the test (0 off, 100 everyone, anything between running). Rule
 *   `experiment { name }`.
 * - `campaigns` (type `calendar`): name → one window `{ start?, end? }`,
 *   ISO date-times with an offset, `end` exclusive. Rule `campaign { name }`.
 *   Every date of a site lives here: a dated variant always names a campaign.
 *
 * Resolving either block gives the site name → true/false, never a share or a
 * date; a section can take the whole map as a prop (`{ "__resolveType":
 * "experiments" }`). Like `cms-settings` (cms-settings.ts), the editor knows
 * only the names and types; everything is read from and written to the
 * content, in a draft.
 */

export type NamedRuleKind = "experiments" | "campaigns";

export interface NamedRuleKindInfo {
  kind: NamedRuleKind;
  /** The well-known saved block that holds every name. */
  blockKey: string;
  /** The built-in type of that block. */
  resolveType: string;
  /** The built-in rule that names one of the block's entries. */
  matcher: string;
  /** The rule's field that holds the name. */
  field: string;
}

const NAMED_RULES: Readonly<Record<NamedRuleKind, NamedRuleKindInfo>> = {
  experiments: {
    kind: "experiments",
    blockKey: "experiments",
    resolveType: "split-traffic",
    matcher: "experiment",
    field: "name",
  },
  campaigns: {
    kind: "campaigns",
    blockKey: "campaigns",
    resolveType: "calendar",
    matcher: "campaign",
    field: "name",
  },
};

export const NAMED_RULE_KINDS: readonly NamedRuleKind[] = [
  "experiments",
  "campaigns",
];

export function namedRuleKindInfo(kind: NamedRuleKind): NamedRuleKindInfo {
  return NAMED_RULES[kind];
}

/** The kind whose rule is `resolveType`, if any. */
function namedRuleKindOfMatcher(resolveType: unknown): NamedRuleKind | null {
  for (const kind of NAMED_RULE_KINDS) {
    if (NAMED_RULES[kind].matcher === resolveType) return kind;
  }
  return null;
}

/** The kind whose saved block is `blockKey`, if any. */
export function namedRuleKindOfBlock(blockKey: unknown): NamedRuleKind | null {
  for (const kind of NAMED_RULE_KINDS) {
    if (NAMED_RULES[kind].blockKey === blockKey) return kind;
  }
  return null;
}

/** The namespace `deco schema` gives the built-ins. */
const BUILT_IN_NAMESPACE = "deco";

/**
 * Whether the site can use a kind, from its schema:
 *
 * - `available`: the schema lists the built-in type and rule (a published
 *   `@decocms/blocks` that has them, `deco schema` run since).
 * - `missing`: it lists neither, or only one of them (an older
 *   `@decocms/blocks`, a schema not regenerated yet, or a v7 site). An older
 *   v8 schema lists `date` (with inline `start`/`end`) but no `calendar` or
 *   `campaign`: that is `missing` too.
 * - `replaced`: the site's block map declares one of the names itself, so the
 *   site's code, not the built-in, decides what they mean.
 */
export type NamedRuleSupport = "available" | "missing" | "replaced";

export function namedRuleSupport(
  meta: Pick<LiveMeta, "manifest"> | null | undefined,
  kind: NamedRuleKind,
): NamedRuleSupport {
  // Only a Blocks v8 site's schema (`isV8Schema`) has them.
  if (!isV8Schema(meta)) return "missing";
  const info = NAMED_RULES[kind];
  const type = findManifestEntry(meta, info.resolveType);
  const matcher = findManifestEntry(meta, info.matcher);
  if (!type || !matcher) return "missing";
  const builtIn = (entry: { namespace?: string }) =>
    entry.namespace === undefined || entry.namespace === BUILT_IN_NAMESPACE;
  return builtIn(type) && builtIn(matcher) ? "available" : "replaced";
}

function findManifestEntry(
  meta: Pick<LiveMeta, "manifest"> | null | undefined,
  key: string,
): { namespace?: string } | null {
  const groups = meta?.manifest?.blocks ?? {};
  for (const group of Object.values(groups)) {
    if (group && Object.hasOwn(group, key)) return group[key] ?? {};
  }
  return null;
}

/** One campaign's window, as saved. */
export interface CampaignWindow {
  start?: string;
  end?: string;
}

/** Per kind, each name's setting: a test's share, a campaign's window. */
export interface NamedRuleValues {
  experiments: Record<string, number>;
  campaigns: Record<string, CampaignWindow>;
}

type ValueOf<K extends NamedRuleKind> = NamedRuleValues[K][string];

/**
 * The well-known block of a kind in a decofile, for an editor to show:
 *
 * - `absent`: no block yet. `block` holds only its type; the first change
 *   creates it (guarded by `ifMatch: { <block>: null }`).
 * - `saved`: the block, with its names. A name whose value isn't the kind's
 *   shape (a share that isn't a whole number from 0 to 100, a window that
 *   isn't an object of strings) is left out of `values` and listed in
 *   `invalid`, so the editor can say so instead of guessing.
 * - `conflict`: a block of that name with another type (`deco check` warns
 *   about it). Nothing is written over it; the editor explains instead.
 */
export type NamedRuleBlock<K extends NamedRuleKind = NamedRuleKind> =
  | {
      kind: "absent";
      block: Record<string, unknown>;
      values: Record<string, ValueOf<K>>;
      invalid: string[];
    }
  | {
      kind: "saved";
      block: Record<string, unknown>;
      values: Record<string, ValueOf<K>>;
      invalid: string[];
    }
  | { kind: "conflict"; resolveType: string };

export function readNamedRuleBlock<K extends NamedRuleKind>(
  decofile: Record<string, unknown>,
  kind: K,
): NamedRuleBlock<K> {
  const info = NAMED_RULES[kind];
  const value = Object.hasOwn(decofile, info.blockKey)
    ? decofile[info.blockKey]
    : undefined;
  if (value === undefined || value === null) {
    return {
      kind: "absent",
      block: { __resolveType: info.resolveType },
      values: Object.create(null),
      invalid: [],
    };
  }
  const resolveType = isPlainRecord(value) ? value.__resolveType : undefined;
  if (resolveType !== info.resolveType) {
    return {
      kind: "conflict",
      resolveType: typeof resolveType === "string" ? resolveType : "",
    };
  }
  const block = value as Record<string, unknown>;
  const values = Object.create(null) as Record<string, ValueOf<K>>;
  const invalid: string[] = [];
  for (const [name, entry] of Object.entries(block)) {
    if (name === "__resolveType") continue;
    const parsed =
      kind === "experiments" ? parseShare(entry) : parseWindow(entry);
    if (parsed === null) invalid.push(name);
    else values[name] = parsed as ValueOf<K>;
  }
  return { kind: "saved", block, values, invalid };
}

/**
 * Whether a test or campaign exists, the one definition every view uses
 * (the picker row, the Experiments tab, the Campaigns view, the Publish
 * review): the block has the name with a value Studio can read. A name
 * whose value can't be read isn't listed anywhere, so it counts as missing
 * too, and creating it writes a readable value in its place.
 */
export function namedRuleExists(read: NamedRuleBlock, name: string): boolean {
  return read.kind !== "conflict" && Object.hasOwn(read.values, name);
}

/** The usable names of both kinds (empty for an absent or conflicting block). */
export function readNamedRuleValues(
  decofile: Record<string, unknown>,
): NamedRuleValues {
  const experiments = readNamedRuleBlock(decofile, "experiments");
  const campaigns = readNamedRuleBlock(decofile, "campaigns");
  return {
    experiments: experiments.kind === "conflict" ? {} : experiments.values,
    campaigns: campaigns.kind === "conflict" ? {} : campaigns.values,
  };
}

function parseShare(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 100
    ? value
    : null;
}

function parseWindow(value: unknown): CampaignWindow | null {
  if (!isPlainRecord(value)) return null;
  const window: CampaignWindow = {};
  for (const bound of ["start", "end"] as const) {
    const raw = value[bound];
    // A cleared field saves as null or "": no bound.
    if (raw === undefined || raw === null || raw === "") continue;
    if (typeof raw !== "string") return null;
    window[bound] = raw;
  }
  return window;
}

/** An A/B test's status, from its share. */
export type ExperimentStatus = "off" | "running" | "everyone";

export function experimentStatus(share: number): ExperimentStatus {
  if (share <= 0) return "off";
  if (share >= 100) return "everyone";
  return "running";
}

/**
 * Whether a test's name can still change: only while it isn't running. The
 * name is what visitors are grouped by and results are kept under, so
 * renaming a running test starts a new one.
 */
export function canRenameExperiment(share: number | undefined): boolean {
  return share === undefined || experimentStatus(share) !== "running";
}

/**
 * The name a rule refers to, when it is a kind's rule with a string name
 * (`experiment { name }`, `campaign { name }`; an empty name included, so an
 * unfinished rule is still found). A `date` rule written inline (`{ start,
 * end }`, from before campaigns) names nothing: it is not a campaign's use.
 */
export function namedRuleOf(
  rule: unknown,
): { kind: NamedRuleKind; name: string } | null {
  if (!isPlainRecord(rule)) return null;
  const kind = namedRuleKindOfMatcher(rule.__resolveType);
  if (!kind) return null;
  const name = rule[NAMED_RULES[kind].field];
  return typeof name === "string" ? { kind, name } : null;
}

/** The rule that names `name`: `experiment { name }` or `campaign { name }`. */
export function namedRule(
  kind: NamedRuleKind,
  name: string,
): Record<string, unknown> {
  const info = NAMED_RULES[kind];
  return { __resolveType: info.matcher, [info.field]: name };
}

/**
 * The rule type v8 had before campaigns: `date { start, end }`, with its own
 * dates. It is no built-in any more; Studio still recognises it to flag it.
 */
const INLINE_DATE_RULE = "date";

/**
 * A `date` rule still written with its own dates (`{ start, end }`), from
 * before campaigns. The runtime no longer runs it (it is false) and `deco
 * check` warns; the migration turns each into a campaign.
 */
export function isInlineDateRule(rule: unknown): boolean {
  return (
    isPlainRecord(rule) &&
    rule.__resolveType === INLINE_DATE_RULE &&
    (Object.hasOwn(rule, "start") || Object.hasOwn(rule, "end"))
  );
}

/**
 * The block with `name` set to `value` (a new name is added last), keeping
 * every other name as saved. `block` is an `absent` or `saved` read's block.
 */
export function withNamedRuleEntry<K extends NamedRuleKind>(
  block: Record<string, unknown>,
  kind: K,
  name: string,
  value: ValueOf<K>,
): Record<string, unknown> {
  return {
    ...block,
    __resolveType: NAMED_RULES[kind].resolveType,
    [name]: value,
  };
}

/** The block without `name`. */
export function withoutNamedRuleEntry(
  block: Record<string, unknown>,
  name: string,
): Record<string, unknown> {
  if (name === "__resolveType") return block;
  const { [name]: _removed, ...rest } = block;
  return rest;
}

/**
 * The block with `from` renamed to `to`, in the same position. Unchanged when
 * `from` is missing or `to` is taken.
 */
export function withRenamedNamedRuleEntry(
  block: Record<string, unknown>,
  from: string,
  to: string,
): Record<string, unknown> {
  if (
    from === to ||
    from === "__resolveType" ||
    to === "__resolveType" ||
    !Object.hasOwn(block, from) ||
    Object.hasOwn(block, to)
  ) {
    return block;
  }
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(block)) {
    next[key === from ? to : key] = value;
  }
  return next;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
