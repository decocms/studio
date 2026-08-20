/**
 * Pure mapping from a git diff to the content-level change model the Fast
 * Preview publish popover renders: pages and blocks by name instead of
 * `.deco/blocks/*.json` file paths. Everything here is derived from the diff's
 * own `from`/`to` JSON — no decofile fetch, no network. Unparsable JSON always
 * degrades (a card without sub-lines, or an "other" row), never throws.
 */

import { decoBlockKeyFromFileStem } from "@decocms/shared/decofile";
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
  /** The diff paths behind this card — what Revert discards. */
  filepaths: string[];
  sections: PublishSectionChange[];
  fromJson: Record<string, unknown> | null;
  toJson: Record<string, unknown> | null;
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

/** Display name for a section entry ("site/sections/Hero.tsx" → "Hero"). */
export function sectionDisplayName(section: unknown, index: number): string {
  if (section && typeof section === "object" && !Array.isArray(section)) {
    const resolveType = (section as Record<string, unknown>).__resolveType;
    if (typeof resolveType === "string" && resolveType.trim()) {
      const basename = resolveType.split("/").pop() ?? resolveType;
      const stem = basename.replace(/\.[jt]sx?$/, "");
      // A saved-block reference resolves to the block key itself — humanize it.
      return humanizeFieldName(stem) || stem;
    }
  }
  return `Section ${index + 1}`;
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
        const value =
          variant && typeof variant === "object" && !Array.isArray(variant)
            ? (variant as Record<string, unknown>).value
            : null;
        if (!Array.isArray(value)) return [];
        return value.flatMap((section, i) =>
          section && typeof section === "object" && !Array.isArray(section)
            ? [
                {
                  section: section as Record<string, unknown>,
                  basePath: ["sections", "variants", vi, "value", i],
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
      changes.push({
        name: sectionDisplayName(toEntry.section, i),
        kind: "section",
        status: "edited",
        fields: shallowFieldDiff(
          fromEntry.section,
          toEntry.section,
          toEntry.basePath,
        ),
      });
    } else if (toEntry) {
      changes.push({
        name: sectionDisplayName(toEntry.section, i),
        kind: "section",
        status: "new",
        fields: [],
      });
    } else if (fromEntry) {
      changes.push({
        name: sectionDisplayName(fromEntry.section, i),
        kind: "section",
        status: "removed",
        fields: [],
      });
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
    blocks.push({
      kind: "block",
      blockKey,
      name: label,
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

function pageNoteName(change: PublishChange): string {
  const sectionNames = change.sections
    .filter((s) => s.kind === "section")
    .map((s) => s.name)
    .slice(0, 3);
  return sectionNames.length > 0
    ? `${change.name} (${sectionNames.join(", ")})`
    : change.name;
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
    segments.push(`updated ${joinNames(editedPages.map(pageNoteName))}`);
  }
  if (newPages.length > 0) {
    const label = newPages.length === 1 ? "page" : "pages";
    segments.push(
      `added the ${joinNames(newPages.map((p) => p.name))} ${label}`,
    );
  }
  if (removedPages.length > 0) {
    const label = removedPages.length === 1 ? "page" : "pages";
    segments.push(
      `removed the ${joinNames(removedPages.map((p) => p.name))} ${label}`,
    );
  }

  const blockNames = summary.blocks.map((b) => b.name);
  if (blockNames.length > 0) {
    segments.push(`changed ${joinNames(blockNames)}`);
  }
  if (summary.other.length > 0) {
    const label = summary.other.length === 1 ? "file" : "files";
    segments.push(`changed ${summary.other.length} ${label}`);
  }

  if (segments.length === 0) return "";
  const note = joinNames(segments);
  return note.charAt(0).toUpperCase() + note.slice(1);
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
