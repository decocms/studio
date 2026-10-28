import type { LiveMeta } from "@/components/sections-editor/resolve-schema";

/**
 * The CMS settings of a Blocks (v8) site: telemetry and analytics, in one
 * optional saved block (the hosts a site shows drafts on are Studio's: it
 * writes them into each release, hosted/preview-hosts.ts in apps/api). Its name and type are the only two
 * things the editor knows about it; the form comes from the schema, which
 * describes the type. A site whose framework has no such type (published
 * `@decocms/blocks` before it existed, or a v7 site) gets no Settings entry.
 */
export const CMS_SETTINGS_BLOCK_KEY = "CMS";
export const CMS_SETTINGS_RESOLVE_TYPE = "cms-settings";

/** Whether the schema describes the `cms-settings` block type. */
export function hasCmsSettingsType(meta: LiveMeta | undefined): boolean {
  const groups = meta?.manifest?.blocks ?? {};
  return Object.values(groups).some(
    (group) => !!group && Object.hasOwn(group, CMS_SETTINGS_RESOLVE_TYPE),
  );
}

export type CmsSettingsBlock =
  /** No `CMS` block yet: every setting is at its default; the first save creates it. */
  | { kind: "absent"; block: Record<string, unknown> }
  | { kind: "saved"; block: Record<string, unknown> }
  /** A block named `CMS` of another type (`deco check` warns about it). */
  | { kind: "conflict"; resolveType: string };

/** The `CMS` block to edit, or a stand-in holding only its type when absent. */
export function readCmsSettingsBlock(
  decofile: Record<string, unknown>,
): CmsSettingsBlock {
  const value = Object.hasOwn(decofile, CMS_SETTINGS_BLOCK_KEY)
    ? decofile[CMS_SETTINGS_BLOCK_KEY]
    : undefined;
  if (value === undefined || value === null) {
    return {
      kind: "absent",
      block: { __resolveType: CMS_SETTINGS_RESOLVE_TYPE },
    };
  }
  const resolveType =
    typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>).__resolveType
      : undefined;
  if (resolveType !== CMS_SETTINGS_RESOLVE_TYPE) {
    return {
      kind: "conflict",
      resolveType: typeof resolveType === "string" ? resolveType : "",
    };
  }
  return { kind: "saved", block: value as Record<string, unknown> };
}

/**
 * The fields the Settings page edits, as `@decocms/blocks` reads them
 * (`telemetrySection`, `analyticsSection`): what each holds and its default
 * when the block leaves it out. The code caps the sample rates
 * (`telemetry.limits`); the page stores what was chosen.
 */
const CMS_SETTINGS_FIELDS = [
  { id: "telemetry.enabled", kind: "boolean", default: true },
  { id: "telemetry.metrics", kind: "boolean", default: true },
  { id: "telemetry.errorSampleRate", kind: "rate", default: 0.05 },
  { id: "telemetry.traceSampleRate", kind: "rate", default: 0 },
  { id: "analytics.enabled", kind: "boolean", default: true },
  { id: "analytics.collector", kind: "url", default: "" },
] as const;

export type CmsSettingsFieldId = (typeof CMS_SETTINGS_FIELDS)[number]["id"];
type CmsSettingsFieldKind = (typeof CMS_SETTINGS_FIELDS)[number]["kind"];
type CmsSettingsSection = "telemetry" | "analytics";

/**
 * A field as the saved block holds it: a plain value (or none, so its
 * default), or something only the block form edits: variants (a
 * `multivariate`, or any block reference, on the field or its whole section)
 * or a value of another kind.
 */
export type CmsSettingsFieldState =
  | { kind: "value"; value: boolean | number | string; isDefault: boolean }
  | { kind: "locked"; reason: "variants" | "other" };

/** The edits made on the page, by field: `undefined` removes the field. */
export type CmsSettingsEdits = Partial<Record<CmsSettingsFieldId, unknown>>;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function splitField(id: CmsSettingsFieldId): [CmsSettingsSection, string] {
  const [section, key] = id.split(".") as [CmsSettingsSection, string];
  return [section, key];
}

function fieldOf(id: CmsSettingsFieldId) {
  return CMS_SETTINGS_FIELDS.find((field) => field.id === id)!;
}

/** Whether `value` is something the page can edit for a field of `kind`. */
function isPlainOf(kind: CmsSettingsFieldKind, value: unknown): boolean {
  if (kind === "boolean") return typeof value === "boolean";
  if (kind === "rate") {
    return typeof value === "number" && Number.isFinite(value);
  }
  return typeof value === "string";
}

/** Variants, a saved block's name or any other resolvable value. */
function isResolvable(value: unknown): boolean {
  return isPlainRecord(value) && typeof value.__resolveType === "string";
}

/** Whether a section is edited only in the block form (variants, or not an object). */
export function cmsSettingsSectionLock(
  block: Record<string, unknown>,
  section: CmsSettingsSection,
): "variants" | "other" | null {
  const value = block[section];
  if (value === undefined || value === null) return null;
  if (isResolvable(value)) return "variants";
  return isPlainRecord(value) ? null : "other";
}

/** A field of the saved block, with its default when absent. */
export function readCmsSettingsField(
  block: Record<string, unknown>,
  id: CmsSettingsFieldId,
): CmsSettingsFieldState {
  const [section, key] = splitField(id);
  const field = fieldOf(id);
  const lock = cmsSettingsSectionLock(block, section);
  if (lock) return { kind: "locked", reason: lock };
  const holder = block[section];
  const value = isPlainRecord(holder) ? holder[key] : undefined;
  if (value === undefined || value === null) {
    return { kind: "value", value: field.default, isDefault: true };
  }
  if (isPlainOf(field.kind, value)) {
    return {
      kind: "value",
      value: value as boolean | number | string,
      isDefault: false,
    };
  }
  return {
    kind: "locked",
    reason: isResolvable(value) ? "variants" : "other",
  };
}

/**
 * The block to save: the saved block with only the edited fields set (an
 * edit of `undefined` removes the field), every other key as it was. A
 * field the page shows read-only (variants, or in a section that is) is
 * never written, whatever the edit says. Never mutates `block`.
 */
export function applyCmsSettingsEdits(
  block: Record<string, unknown>,
  edits: CmsSettingsEdits,
): Record<string, unknown> {
  const next: Record<string, unknown> = {
    ...block,
    __resolveType: CMS_SETTINGS_RESOLVE_TYPE,
  };
  for (const field of CMS_SETTINGS_FIELDS) {
    if (!Object.hasOwn(edits, field.id)) continue;
    if (readCmsSettingsField(block, field.id).kind === "locked") continue;
    const value = edits[field.id];
    if (value !== undefined && !isPlainOf(field.kind, value)) continue;
    const [section, key] = splitField(field.id);
    const current = next[section];
    if (value === undefined) {
      // Nothing to remove: no empty section, no change.
      if (!isPlainRecord(current) || !Object.hasOwn(current, key)) continue;
      const copy = { ...current };
      delete copy[key];
      next[section] = copy;
      continue;
    }
    next[section] = {
      ...(isPlainRecord(current) ? current : {}),
      [key]: value,
    };
  }
  return next;
}

/**
 * Whether an edit leaves a field as the saved block has it (a value left out
 * counts as its default), so there is nothing to write: switched off and on
 * again, or a collector typed and cleared.
 */
export function isUnchangedCmsSettingsEdit(
  block: Record<string, unknown>,
  id: CmsSettingsFieldId,
  value: unknown,
): boolean {
  const saved = readCmsSettingsField(block, id);
  if (saved.kind !== "value") return false;
  const shown = value === undefined ? fieldOf(id).default : value;
  return saved.value === shown;
}

/** A sample rate (0..1) as the percentage the page shows: 0.05 → 5. */
export function rateToPercent(rate: number): number {
  return Number((rate * 100).toFixed(4));
}

/**
 * A percentage typed on the page as the rate to store (5 → 0.05), or null
 * when it isn't a number from 0 to 100.
 */
export function percentToRate(text: string): number | null {
  const trimmed = text.trim().replace(",", ".");
  if (!trimmed) return null;
  const percent = Number(trimmed);
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) return null;
  return Number((percent / 100).toFixed(6));
}

/** Whether a collector typed on the page can be saved: empty, or an http(s) URL. */
export function isCollectorUrl(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  try {
    const url = new URL(trimmed);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}
