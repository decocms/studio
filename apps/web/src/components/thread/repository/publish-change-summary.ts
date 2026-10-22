/**
 * Pure mapping from a git diff to the content-level change model the Fast
 * Preview publish popover renders: pages and blocks by name instead of
 * `.deco/blocks/*.json` file paths. Everything here is derived from the diff's
 * own `from`/`to` JSON — no decofile fetch, no network. Unparsable JSON always
 * degrades (a card without sub-lines, or an "other" row), never throws.
 */

import {
  blockNameFromFile,
  type Change,
  spellingKey,
} from "@decocms/blocks/protocol";
import {
  decoBlockKeyFromFileStem,
  isSecretBlock as isLegacySecretBlock,
} from "@decocms/shared/decofile";
import { SECRET_BLOCK_TYPE } from "@decocms/shared/secret-ciphertext";
import { isLazyWrapper } from "@/components/sections-editor/lazy-value";
import { isLazyResolveType } from "@/components/sections-editor/section-lazy";
import { labelFromResolveType } from "@/components/sections-editor/section-types";
import { isMultivariateResolveType } from "@/components/sections-editor/variant-shape";
import type { ContentChangeSides } from "@/components/sections-editor/content-changes";
import type { LiveMeta } from "@/components/sections-editor/resolve-schema";
import {
  NAMED_RULE_KINDS,
  type NamedRuleKind,
  namedRuleKindInfo,
  namedRuleKindOfBlock,
} from "@/components/sections-editor/named-rules";
import type { MissingNamedRuleUseCounts } from "@/components/sections-editor/named-rule-uses";
import {
  globalSectionLabel,
  isSiteAppBlock,
  pageEntryFromBlock,
  parsePageName,
} from "@/components/sections-editor/page-list";
import {
  isGeneratedArtifactPath,
  type GitChangedFile,
  type GitDiffResult,
} from "./sandbox-git-api";
import { shortenTitle } from "./publish-flow.ts";

export type PublishChangeStatus = "new" | "edited" | "removed";

export interface PublishFieldChange {
  /** Humanized field name ("Background image" for `backgroundImage`). */
  label: string;
  /** JSON path from the block root to the field. */
  path: (string | number)[];
  /** `undefined` means the field is absent on that side. */
  from: unknown;
  to: unknown;
}

export interface PublishSectionChange {
  name: string;
  /**
   * `settings` is the synthetic entry carrying a page's changed top-level
   * fields — a discriminant, so callers never key off the display name.
   */
  kind: "section" | "settings";
  status: PublishChangeStatus;
  fields: PublishFieldChange[];
  /**
   * The section is variants (lazy-loaded or not), so `name` is the wrapper's
   * type ("Multivariate"), not a name the author knows. The version note
   * leaves it out. A lazy-loaded section is named by the section it loads.
   */
  wrapper?: true;
  /**
   * On a `wrapper`: the sections its variants hold (through lazy blocks), by
   * name, those of the variants that changed first. The version note names
   * these instead of the wrapper.
   */
  held?: string[];
}

export interface PublishChange {
  kind: "page" | "block" | "other";
  /** Decofile block key; null for non-block files. */
  blockKey: string | null;
  name: string;
  /** Page path ("/black-friday"); null for blocks and plain files. */
  pagePath: string | null;
  /** True when the block is the site app / site configuration block. */
  isSiteApp: boolean;
  status: PublishChangeStatus;
  /** The diff paths behind this card — what Revert discards (git sources). */
  filepaths: string[];
  /**
   * A v8 change (`changes.list`): the entry behind this card and the version
   * the list showed, which its discard is guarded by. `filepaths` is empty.
   */
  entry?: { name: string; version: string | null };
  /** v8: the sides that exist but couldn't be read (invalid JSON, too large). */
  unreadable?: Array<"before" | "after">;
  sections: PublishSectionChange[];
  fromJson: Record<string, unknown> | null;
  toJson: Record<string, unknown> | null;
  /**
   * v8: its rules name a test or campaign of these kinds that the draft
   * doesn't have (deleted, discarded, never created). The card says so;
   * nothing is blocked.
   */
  missingRules?: NamedRuleKind[];
  /**
   * v8, on the A/B tests or Campaigns card: how many pages and how many
   * sections use a name the draft doesn't have. Those may have no card of
   * their own; nothing is blocked.
   */
  missingRuleUses?: { kind: NamedRuleKind } & MissingNamedRuleUseCounts;
  /**
   * The site's A/B tests or campaigns block, known when the card is built
   * (from the current blocks, either side, or its name when no content can be
   * read), so the card says so before and whether or not its sides load.
   */
  namedRule?: NamedRuleKind;
}

/**
 * The site's A/B tests (`split-traffic`) or campaigns (`calendar`) block
 * behind a block card, from its content; null for any other block. They are
 * content, not sections, so the card names them as such.
 */
export function namedRuleBlockOfChange(
  change: Pick<PublishChange, "kind" | "toJson" | "fromJson" | "namedRule">,
): NamedRuleKind | null {
  if (change.kind !== "block") return null;
  return (
    change.namedRule ?? namedRuleKindOfShape(change.toJson ?? change.fromJson)
  );
}

/** The named-rule block a block's content is, by its type. */
function namedRuleKindOfShape(
  shape: Record<string, unknown> | null | undefined,
): NamedRuleKind | null {
  const resolveType = shape?.__resolveType;
  for (const kind of NAMED_RULE_KINDS) {
    if (namedRuleKindInfo(kind).resolveType === resolveType) return kind;
  }
  return null;
}

/**
 * The named-rule block a changed block is: by its content's type when any
 * side can be read (a block of that name with another type is not one). On
 * a v8 site (`byName`), by its name when none can, since the sides load
 * after the list and may not load at all.
 */
function namedRuleOfBlock(
  name: string,
  shapes: Array<Record<string, unknown> | null | undefined>,
  byName: boolean,
): NamedRuleKind | null {
  const shape = shapes.find((s) => s && typeof s === "object");
  if (shape) return namedRuleKindOfShape(shape);
  return byName ? namedRuleKindOfBlock(name) : null;
}

export interface PublishChangeSummary {
  pages: PublishChange[];
  blocks: PublishChange[];
  other: PublishChange[];
  /** Auto-regenerated artifacts, excluded from the cards (never user intent). */
  generated: string[];
  /** Cards shown to the user: pages + blocks + other. */
  count: number;
}

const BLOCK_FILE_RE = /(?:^|\/)\.deco\/blocks\/([^/]+)\.json$/;

/** Decofile block key for a `.deco/blocks/<stem>.json` diff path; else null. */
export function blockKeyFromDiffPath(path: string): string | null {
  const stem = BLOCK_FILE_RE.exec(path)?.[1];
  return stem ? decoBlockKeyFromFileStem(stem) : null;
}

function parseBlockJson(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Malformed block JSON — degrade to a card without sub-lines.
  }
  return null;
}

function changeStatus(from: string | null, to: string | null) {
  if (from === null) return "new" as const;
  if (to === null) return "removed" as const;
  return "edited" as const;
}

/** "backgroundImage" / "background_image" → "Background image". */
export function humanizeFieldName(key: string): string {
  const spaced = key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim();
  if (!spaced) return key;
  return (spaced.charAt(0).toUpperCase() + spaced.slice(1)).replace(
    /\s+[A-Z](?=[a-z])/g,
    (m) => m.toLowerCase(),
  );
}

/**
 * Display name for a section entry ("site/sections/Hero.tsx" → "Hero"), as the
 * site editor's section list and "Used by" name it (`labelFromResolveType`), so
 * the release title says "Hero Scene" where the editor does.
 */
export function sectionDisplayName(section: unknown, index: number): string {
  if (section && typeof section === "object" && !Array.isArray(section)) {
    const resolveType = (section as Record<string, unknown>).__resolveType;
    if (typeof resolveType === "string" && resolveType.trim()) {
      return labelFromResolveType(resolveType);
    }
  }
  return `Section ${index + 1}`;
}

/**
 * The section a lazy-loading wrapper holds (v8 `lazy` block, v7 Lazy section),
 * or `null` for a section that isn't one.
 */
function lazyInner(section: Record<string, unknown>): unknown {
  const resolveType = section.__resolveType;
  if (resolveType === "lazy") return section.value ?? null;
  if (typeof resolveType === "string" && isLazyResolveType(resolveType)) {
    return section.section ?? null;
  }
  return null;
}

/** How deep variants and lazy blocks are followed to the sections they hold. */
const MAX_HELD_DEPTH = 6;

/**
 * The sections a value holds: itself, or through lazy blocks and into every
 * variant of a variants block (a variant's value may be one section or a list).
 */
function heldSections(value: unknown, depth = 0): Record<string, unknown>[] {
  if (depth > MAX_HELD_DEPTH || !value || typeof value !== "object") return [];
  if (Array.isArray(value)) {
    return value.flatMap((item) => heldSections(item, depth + 1));
  }
  const record = value as Record<string, unknown>;
  if (isMultivariateResolveType(record.__resolveType)) {
    return variantsOf(record).flatMap((variant) =>
      heldSections(variant?.value, depth + 1),
    );
  }
  const inner = lazyInner(record);
  if (inner !== null) return heldSections(inner, depth + 1);
  return [record];
}

function variantsOf(
  record: Record<string, unknown> | null | undefined,
): Array<Record<string, unknown> | null> {
  const variants = record?.variants;
  if (!Array.isArray(variants)) return [];
  return variants.map((variant) =>
    variant && typeof variant === "object" && !Array.isArray(variant)
      ? (variant as Record<string, unknown>)
      : null,
  );
}

/** Unwraps lazy blocks down to the variants block they hold, if any. */
function variantsBlock(value: unknown): Record<string, unknown> | null {
  let current: unknown = value;
  for (let depth = 0; depth < MAX_HELD_DEPTH; depth++) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return null;
    }
    const record = current as Record<string, unknown>;
    if (isMultivariateResolveType(record.__resolveType)) return record;
    const inner = lazyInner(record);
    if (inner === null) return null;
    current = inner;
  }
  return null;
}

/**
 * The names of the sections a variants block holds: those of the variants
 * that changed from `previous` (when given) first, then the rest, each once.
 */
function heldNames(
  section: Record<string, unknown>,
  previous: Record<string, unknown> | undefined,
  index: number,
): string[] {
  const now = variantsOf(variantsBlock(section));
  const before = previous ? variantsOf(variantsBlock(previous)) : [];
  const changed = previous
    ? Array.from(
        { length: Math.max(now.length, before.length) },
        (_, i) => i,
      ).filter((i) => !sameValue(now[i], before[i]))
    : [];
  const ordered = [
    ...changed.map((i) => now[i] ?? before[i]),
    ...now.filter((_, i) => !changed.includes(i)),
  ];
  const names = ordered
    .flatMap((variant) => heldSections(variant?.value))
    .map((held) => sectionDisplayName(held, index));
  return [...new Set(names)];
}

/**
 * A changed section, by the name of the section it is: a lazy-loaded one by
 * the section it loads, and flagged `wrapper` when it is variants (or a lazy
 * wrapper around them), whose type is no name the author knows; a wrapper
 * carries the names of the sections its variants hold.
 */
function sectionChange(
  section: Record<string, unknown>,
  index: number,
  status: PublishChangeStatus,
  fields: PublishFieldChange[],
  previous?: Record<string, unknown>,
): PublishSectionChange {
  let named: unknown = section;
  let wrapper = false;
  for (let depth = 0; depth < 4; depth++) {
    if (!named || typeof named !== "object" || Array.isArray(named)) {
      wrapper = true;
      break;
    }
    const record = named as Record<string, unknown>;
    if (isMultivariateResolveType(record.__resolveType)) {
      wrapper = true;
      break;
    }
    const inner = lazyInner(record);
    if (inner === null) break;
    named = inner;
  }
  const held = wrapper ? heldNames(section, previous, index) : [];
  return {
    name: wrapper
      ? sectionDisplayName(section, index)
      : sectionDisplayName(named, index),
    kind: "section",
    status,
    fields,
    ...(wrapper ? { wrapper: true as const } : {}),
    ...(held.length > 0 ? { held } : {}),
  };
}

interface SectionWithPath {
  section: Record<string, unknown>;
  /** Path from the block root to this section object. */
  basePath: (string | number)[];
}

/**
 * A page's sections live either directly under `sections` (a plain array) or
 * per variant under `sections.variants[i].value` (multivariate pages). Returns
 * each section with the JSON path that reaches it, valid in both shapes.
 */
function sectionsWithPaths(block: Record<string, unknown>): SectionWithPath[] {
  const sections = block.sections;
  if (Array.isArray(sections)) {
    return sections.flatMap((section, i) =>
      section && typeof section === "object" && !Array.isArray(section)
        ? [
            {
              section: section as Record<string, unknown>,
              basePath: ["sections", i],
            },
          ]
        : [],
    );
  }
  if (sections && typeof sections === "object") {
    const variants = (sections as Record<string, unknown>).variants;
    if (Array.isArray(variants)) {
      return variants.flatMap((variant, vi) => {
        const stored =
          variant && typeof variant === "object" && !Array.isArray(variant)
            ? (variant as Record<string, unknown>).value
            : null;
        // v8's `multivariate` keeps the list in a `lazy` block, one `value` deeper.
        const lazy = isLazyWrapper(stored);
        const value = lazy ? stored.value : stored;
        if (!Array.isArray(value)) return [];
        const listPath: (string | number)[] = lazy
          ? ["sections", "variants", vi, "value", "value"]
          : ["sections", "variants", vi, "value"];
        return value.flatMap((section, i) =>
          section && typeof section === "object" && !Array.isArray(section)
            ? [
                {
                  section: section as Record<string, unknown>,
                  basePath: [...listPath, i],
                },
              ]
            : [],
        );
      });
    }
  }
  return [];
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, val: unknown) => {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const record = val as Record<string, unknown>;
      return Object.keys(record)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = record[k];
          return acc;
        }, {});
    }
    return val;
  });
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === undefined && b === undefined) return true;
  return stableStringify(a) === stableStringify(b);
}

/** Shallow field diff of two objects, skipping internal `__*` keys. */
function shallowFieldDiff(
  from: Record<string, unknown> | null,
  to: Record<string, unknown> | null,
  basePath: (string | number)[],
  skip: ReadonlySet<string> = new Set(),
): PublishFieldChange[] {
  const keys = new Set([...Object.keys(from ?? {}), ...Object.keys(to ?? {})]);
  const fields: PublishFieldChange[] = [];
  for (const key of keys) {
    if (key.startsWith("__") || skip.has(key)) continue;
    const fromVal = from ? from[key] : undefined;
    const toVal = to ? to[key] : undefined;
    if (sameValue(fromVal, toVal)) continue;
    fields.push({
      label: humanizeFieldName(key),
      path: [...basePath, key],
      from: fromVal,
      to: toVal,
    });
  }
  return fields;
}

const PAGE_TOP_LEVEL_SKIP = new Set(["sections"]);

/** Section-level changes between two parsed page blocks. */
function diffPageSections(
  from: Record<string, unknown> | null,
  to: Record<string, unknown> | null,
): PublishSectionChange[] {
  const fromSections = from ? sectionsWithPaths(from) : [];
  const toSections = to ? sectionsWithPaths(to) : [];
  const changes: PublishSectionChange[] = [];

  const max = Math.max(fromSections.length, toSections.length);
  for (let i = 0; i < max; i++) {
    const fromEntry = fromSections[i];
    const toEntry = toSections[i];
    if (fromEntry && toEntry) {
      if (sameValue(fromEntry.section, toEntry.section)) continue;
      changes.push(
        sectionChange(
          toEntry.section,
          i,
          "edited",
          shallowFieldDiff(
            fromEntry.section,
            toEntry.section,
            toEntry.basePath,
          ),
          fromEntry.section,
        ),
      );
    } else if (toEntry) {
      changes.push(sectionChange(toEntry.section, i, "new", []));
    } else if (fromEntry) {
      changes.push(sectionChange(fromEntry.section, i, "removed", []));
    }
  }

  const topLevel = shallowFieldDiff(from, to, [], PAGE_TOP_LEVEL_SKIP);
  if (topLevel.length > 0) {
    changes.push({
      name: "Page settings",
      kind: "settings",
      status: "edited",
      fields: topLevel,
    });
  }
  return changes;
}

function otherChange(path: string, status: PublishChangeStatus): PublishChange {
  const basename = path.split("/").pop() ?? path;
  return {
    kind: "other",
    blockKey: null,
    name: basename,
    pagePath: null,
    isSiteApp: false,
    status,
    filepaths: [path],
    sections: [],
    fromJson: null,
    toJson: null,
  };
}

export function summarizePublishChanges(
  diff: GitDiffResult | null | undefined,
): PublishChangeSummary {
  const pages: PublishChange[] = [];
  const blocks: PublishChange[] = [];
  const other: PublishChange[] = [];
  const generated: string[] = [];

  for (const [path, entry] of Object.entries(diff?.diffs ?? {})) {
    if (isGeneratedArtifactPath(path)) {
      generated.push(path);
      continue;
    }
    const status = changeStatus(entry.from, entry.to);
    const blockKey = blockKeyFromDiffPath(path);
    if (!blockKey) {
      other.push(otherChange(path, status));
      continue;
    }

    const fromJson = parseBlockJson(entry.from);
    const toJson = parseBlockJson(entry.to);
    const shape = toJson ?? fromJson;
    if (!shape) {
      other.push(otherChange(path, status));
      continue;
    }

    const page = pageEntryFromBlock(blockKey, shape);
    if (page) {
      pages.push({
        kind: "page",
        blockKey,
        name: page.name,
        pagePath: page.path,
        isSiteApp: false,
        status,
        filepaths: [path],
        sections: status === "edited" ? diffPageSections(fromJson, toJson) : [],
        fromJson,
        toJson,
      });
      continue;
    }

    const siteApp = isSiteAppBlock(blockKey, shape);
    blocks.push({
      kind: "block",
      blockKey,
      name: globalSectionLabel(blockKey, shape),
      pagePath: null,
      isSiteApp: siteApp,
      status,
      filepaths: [path],
      sections:
        status === "edited"
          ? [
              {
                name: globalSectionLabel(blockKey, shape),
                kind: "section" as const,
                status: "edited" as const,
                fields: shallowFieldDiff(fromJson, toJson, []),
              },
            ].filter((s) => s.fields.length > 0)
          : [],
      fromJson,
      toJson,
    });
  }

  return collectSummary({ pages, blocks, other, generated });
}

/**
 * Sorted by file path, not by display name: a card must not reposition when
 * its name sharpens from the block key to the parsed title.
 */
function byPath(a: PublishChange, b: PublishChange): number {
  return (a.filepaths[0] ?? "").localeCompare(b.filepaths[0] ?? "");
}

function collectSummary(buckets: {
  pages: PublishChange[];
  blocks: PublishChange[];
  other: PublishChange[];
  generated: string[];
}): PublishChangeSummary {
  const { pages, blocks, other, generated } = buckets;
  pages.sort(byPath);
  blocks.sort(byPath);
  other.sort(byPath);
  return {
    pages,
    blocks,
    other,
    generated,
    count: pages.length + blocks.length + other.length,
  };
}

/** Manifest statuses collapse onto the three the surface draws. */
function manifestStatus(status: GitChangedFile["status"]): PublishChangeStatus {
  if (status === "added") return "new";
  if (status === "removed") return "removed";
  return "edited";
}

/** A block-keyed path is a page when its content says so — or, with no content
 *  to read, when it follows the `pages-<name>-<id>` key convention. */
function looksLikePageKey(blockKey: string): boolean {
  return blockKey.startsWith("pages-");
}

interface ManifestInput {
  /** Changed paths and how they changed — the whole card list. */
  files: readonly GitChangedFile[];
  /**
   * The branch head decofile, keyed by block key. Supplies names, page paths
   * and classification for every path that still exists on the branch, so the
   * list is complete before any file body has been fetched.
   */
  lookup?: Record<string, unknown> | null;
  /** File bodies, once loaded. Enriches cards; never re-classifies them. */
  diff?: GitDiffResult | null;
}

/**
 * The publish change model built from the changed-file MANIFEST — which paths
 * changed — with file bodies as an optional enrichment rather than a
 * prerequisite. This is what lets the publish surface render its real list one
 * request in, and it is the only entry point the Fast Preview popover uses.
 *
 * Card identity, kind, status and order come from the manifest and the head
 * decofile alone, never from `diff`, so a body arriving later cannot remount a
 * card, move it between groups, re-sort it, or recolor it. Bodies add only the
 * section sub-lines and the raw JSON the expanded diff renders.
 *
 * One consequence worth naming: a REMOVED block is absent from the head
 * decofile, so it classifies by key convention. A removed page not keyed
 * `pages-*` lists under Blocks — stable and correctly named, in the wrong
 * group. Reclassifying it once bodies land would be more accurate and worse.
 */
export function summarizePublishManifest(
  input: ManifestInput,
): PublishChangeSummary {
  const { files, lookup, diff } = input;
  const pages: PublishChange[] = [];
  const blocks: PublishChange[] = [];
  const other: PublishChange[] = [];
  const generated: string[] = [];

  for (const file of files) {
    const path = file.path;
    if (isGeneratedArtifactPath(path)) {
      generated.push(path);
      continue;
    }
    const status = manifestStatus(file.status);
    const blockKey = blockKeyFromDiffPath(path);
    if (!blockKey) {
      other.push(otherChange(path, status));
      continue;
    }

    const body = diff?.diffs[path];
    const fromJson = parseBlockJson(body?.from ?? null);
    const toJson = parseBlockJson(body?.to ?? null);
    const headShape = readBlockShape(lookup, blockKey);
    // Classification reads the head shape ONLY — see the doc above.
    const nameShape = headShape ?? toJson ?? fromJson;

    const headPage = headShape ? pageEntryFromBlock(blockKey, headShape) : null;
    if (headPage ?? (!headShape && looksLikePageKey(blockKey))) {
      const namePage = nameShape
        ? pageEntryFromBlock(blockKey, nameShape)
        : null;
      pages.push({
        kind: "page",
        blockKey,
        name: namePage?.name ?? parsePageName(blockKey),
        pagePath: namePage?.path ?? null,
        isSiteApp: false,
        status,
        filepaths: [path],
        sections: status === "edited" ? diffPageSections(fromJson, toJson) : [],
        fromJson,
        // `new` never diffs sections, so the head shape is a safe stand-in.
        toJson: toJson ?? (status === "new" ? headShape : null),
      });
      continue;
    }

    const label = globalSectionLabel(blockKey, nameShape ?? {});
    const namedRule = namedRuleOfBlock(
      blockKey,
      [headShape, toJson, fromJson],
      false,
    );
    blocks.push({
      kind: "block",
      blockKey,
      name: label,
      ...(namedRule ? { namedRule } : {}),
      pagePath: null,
      isSiteApp: isSiteAppBlock(blockKey, headShape ?? {}),
      status,
      filepaths: [path],
      sections:
        status === "edited"
          ? [
              {
                name: label,
                kind: "section" as const,
                status: "edited" as const,
                fields: shallowFieldDiff(fromJson, toJson, []),
              },
            ].filter((s) => s.fields.length > 0)
          : [],
      fromJson,
      toJson,
    });
  }

  return collectSummary({ pages, blocks, other, generated });
}

/** The head decofile's entry for a block key, when it is a plain object. */
function readBlockShape(
  lookup: Record<string, unknown> | null | undefined,
  blockKey: string,
): Record<string, unknown> | null {
  const value = lookup?.[blockKey];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The version note to render: the author's text once they have typed anything,
 * otherwise the note derived from the current change set.
 *
 * `??`, never `||` — an author who deliberately clears the field must not have
 * it refilled underneath them.
 */
export function resolveVersionNote(
  edited: string | null,
  autoNote: string,
): string {
  return edited ?? autoNote;
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** Names past this many collapse into "and N more" — the note is a title. */
const MAX_NOTE_NAMES = 3;

function listNames(names: string[]): string {
  if (names.length <= MAX_NOTE_NAMES) return joinNames(names);
  const rest = names.length - MAX_NOTE_NAMES;
  return `${names.slice(0, MAX_NOTE_NAMES).join(", ")} and ${rest} more`;
}

/**
 * "Home (Hero, Footer)": the page and the sections the author knows by name.
 * A wrapper's type ("Multivariate", "Lazy") says nothing to them, so variants
 * are named by the sections they hold ("Home (Hero)"); variants that hold no
 * section by name leave the page alone: "Home".
 */
function pageNoteName(change: PublishChange): string {
  const sectionNames = [
    ...new Set(
      change.sections
        .filter((s) => s.kind === "section")
        .flatMap((s) => (s.wrapper ? (s.held ?? []) : [s.name])),
    ),
  ].slice(0, 3);
  return sectionNames.length > 0
    ? `${change.name} (${sectionNames.join(", ")})`
    : change.name;
}

/** The site's A/B tests and campaigns blocks by what they hold, as the cards call them. */
function blockNoteName(change: PublishChange): string {
  const named = namedRuleBlockOfChange(change);
  if (named === "experiments") return "A/B tests";
  if (named === "campaigns") return "Campaign dates";
  return change.name;
}

/**
 * Deterministic, zero-latency version note derived from the change model.
 * Deliberately English: the note becomes the commit / PR title, which stays
 * English like every other server-bound string (see the i18n scope rules) —
 * the AI suggestion that replaces it is English for the same reason.
 */
export function buildAutoNote(summary: PublishChangeSummary): string {
  const segments: string[] = [];

  const editedPages = summary.pages.filter((p) => p.status === "edited");
  const newPages = summary.pages.filter((p) => p.status === "new");
  const removedPages = summary.pages.filter((p) => p.status === "removed");

  if (editedPages.length > 0) {
    segments.push(`updated ${listNames(editedPages.map(pageNoteName))}`);
  }
  if (newPages.length > 0) {
    const label = newPages.length === 1 ? "page" : "pages";
    segments.push(
      `added the ${listNames(newPages.map((p) => p.name))} ${label}`,
    );
  }
  if (removedPages.length > 0) {
    const label = removedPages.length === 1 ? "page" : "pages";
    segments.push(
      `removed the ${listNames(removedPages.map((p) => p.name))} ${label}`,
    );
  }

  const blockNames = summary.blocks.map(blockNoteName);
  if (blockNames.length > 0) {
    segments.push(`changed ${listNames(blockNames)}`);
  }
  if (summary.other.length > 0) {
    const label = summary.other.length === 1 ? "file" : "files";
    segments.push(`changed ${summary.other.length} ${label}`);
  }

  if (segments.length === 0) return "";
  const note = joinNames(segments);
  return shortenTitle(note.charAt(0).toUpperCase() + note.slice(1));
}

/** Section count of a parsed page block, across both section shapes. */
function countPageSections(block: Record<string, unknown> | null): number {
  return block ? sectionsWithPaths(block).length : 0;
}

/**
 * How much a card changed, as counts rather than a list of names.
 *
 * The names are the problem this replaces: a section's display name comes from
 * its `__resolveType`, which for a lazy-loaded or wrapper section is the
 * wrapper ("Lazy", "Section"), not the content the author recognizes. Twenty
 * rows of "Lazy — Section" told the reader nothing and buried the card. The
 * expanded diff still shows every field; the collapsed card only carries
 * magnitude.
 */
export interface PublishChangeDigest {
  /** Sections in a brand-new page; null when the card is not a new page. */
  newPageSections: number | null;
  /** Changed sections on an edited page — the settings entry excluded. */
  sections: number;
  /** The page's top-level fields changed too. */
  settings: boolean;
  /** Changed fields on a block card. */
  fields: number;
}

export function publishChangeDigest(
  change: PublishChange,
): PublishChangeDigest {
  const digest: PublishChangeDigest = {
    newPageSections:
      change.kind === "page" && change.status === "new"
        ? countPageSections(change.toJson)
        : null,
    sections: 0,
    settings: false,
    fields: 0,
  };
  if (digest.newPageSections !== null) return digest;

  for (const section of change.sections) {
    if (section.kind === "settings") {
      digest.settings = true;
      continue;
    }
    if (change.kind === "page") {
      digest.sections += 1;
    } else {
      digest.fields += section.fields.length;
    }
  }
  return digest;
}

/** The text a secret shows in a change summary: it's compared, never shown. */
export const SECRET_MASK = "••••••";

/**
 * `value` with every secret's ciphertext (a v8 `secret` block's `ciphertext`,
 * a v7 secret loader's `encrypted`) replaced by {@link SECRET_MASK}. Applied
 * after comparing, so a changed secret still shows as changed.
 */
export function maskSecrets<T>(value: T): T {
  if (Array.isArray(value)) return value.map(maskSecrets) as T;
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(record))
    out[key] = maskSecrets(inner);
  if (record.__resolveType === SECRET_BLOCK_TYPE && "ciphertext" in record) {
    out.ciphertext = SECRET_MASK;
  }
  if (isLegacySecretBlock(record) && "encrypted" in record) {
    out.encrypted = SECRET_MASK;
  }
  return out as T;
}

function maskFields(fields: PublishFieldChange[]): PublishFieldChange[] {
  return fields.map((field) => ({
    ...field,
    from: maskSecrets(field.from),
    to: maskSecrets(field.to),
  }));
}

interface ContentChangesInput {
  /** `changes.list`'s answer: the whole card list. */
  changes: Record<string, Change>;
  /** Both sides (`changes.get`), once loaded: they only enrich the cards. */
  sides?: ContentChangeSides | null;
  /** The current blocks (the editor's decofile), for names and kinds. */
  lookup?: Record<string, unknown> | null;
  /**
   * The site schema, when the editor has read it: its page types. A v8 page
   * is the built-in `page`, which only the schema names as a page; without
   * it the page reads as a global section with one changed field.
   */
  meta?: LiveMeta | null;
  /**
   * Per block, the kinds of test or campaign its rules name that the draft
   * doesn't have (named-rule-uses.ts `blocksUsingMissingNamedRules`).
   */
  missingRules?: ReadonlyMap<string, NamedRuleKind[]>;
  /**
   * Per kind, how many pages and how many sections use a name the draft
   * doesn't have (named-rule-uses.ts `missingNamedRuleUseCounts`).
   */
  missingRuleUses?: ReadonlyMap<NamedRuleKind, MissingNamedRuleUseCounts>;
}

/**
 * The publish change model from a v8 source's changes (`changes.list`),
 * keyed by entry name, each card carrying the version its discard is guarded
 * by. As with {@link summarizePublishManifest}, a card's identity, kind,
 * status and order come from the list and the current blocks alone; both
 * sides only add what changed inside it. Secrets are compared, never shown.
 */
export function summarizeContentChanges(
  input: ContentChangesInput,
): PublishChangeSummary {
  const { changes, sides, lookup, meta, missingRules, missingRuleUses } = input;
  const pages: PublishChange[] = [];
  const blocks: PublishChange[] = [];
  /** The sides of `name` the server couldn't read (any spelling's file). */
  const unreadableOf = (name: string) => [
    ...new Set(
      (sides?.diagnostics ?? [])
        .filter(
          (d) => spellingKey(blockNameFromFile(d.file)) === spellingKey(name),
        )
        .map((d) => d.side),
    ),
  ];
  const names = Object.keys(changes).sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  for (const name of names) {
    const change = changes[name]!;
    const status: PublishChangeStatus =
      change.kind === "delete"
        ? "removed"
        : change.baseVersion === null
          ? "new"
          : "edited";
    const detail = sides?.entries[name];
    const fromJson = detail?.before ?? null;
    const toJson = detail?.after ?? null;
    const headShape = readBlockShape(lookup, name);
    const nameShape = headShape ?? toJson ?? fromJson;
    const unreadable = unreadableOf(name);
    const missing = missingRules?.get(name);
    const ruleKind = namedRuleKindOfBlock(name);
    const usesCounts = ruleKind ? missingRuleUses?.get(ruleKind) : undefined;
    const common = {
      blockKey: name,
      status,
      filepaths: [],
      entry: { name, version: change.version },
      ...(unreadable.length > 0 ? { unreadable } : {}),
      ...(missing && missing.length > 0 ? { missingRules: missing } : {}),
      ...(ruleKind && usesCounts && usesCounts.pages + usesCounts.sections > 0
        ? { missingRuleUses: { kind: ruleKind, ...usesCounts } }
        : {}),
      fromJson: maskSecrets(fromJson),
      toJson: maskSecrets(toJson ?? (status === "new" ? headShape : null)),
    };

    const headPage = headShape
      ? pageEntryFromBlock(name, headShape, meta)
      : null;
    const shapePage =
      !headShape && nameShape
        ? pageEntryFromBlock(name, nameShape, meta)
        : null;
    if (headPage ?? shapePage ?? (!nameShape && looksLikePageKey(name))) {
      const namePage = nameShape
        ? pageEntryFromBlock(name, nameShape, meta)
        : null;
      pages.push({
        ...common,
        kind: "page",
        name: namePage?.name ?? parsePageName(name),
        pagePath: namePage?.path ?? null,
        isSiteApp: false,
        sections:
          status === "edited"
            ? diffPageSections(fromJson, toJson).map((section) => ({
                ...section,
                fields: maskFields(section.fields),
              }))
            : [],
      });
      continue;
    }
    const label = globalSectionLabel(name, nameShape ?? {});
    const namedRule = namedRuleOfBlock(
      name,
      [headShape, toJson, fromJson],
      true,
    );
    blocks.push({
      ...common,
      kind: "block",
      name: label,
      ...(namedRule ? { namedRule } : {}),
      pagePath: null,
      isSiteApp: isSiteAppBlock(name, headShape ?? nameShape ?? {}),
      sections:
        status === "edited"
          ? [
              {
                name: label,
                kind: "section" as const,
                status: "edited" as const,
                fields: maskFields(shallowFieldDiff(fromJson, toJson, [])),
              },
            ].filter((s) => s.fields.length > 0)
          : [],
    });
  }
  // Already in name order: a card never moves as its title sharpens.
  return {
    pages,
    blocks,
    other: [],
    generated: [],
    count: pages.length + blocks.length,
  };
}
