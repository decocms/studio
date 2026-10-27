import { canonicalBlockJson } from "@decocms/shared/decofile";
import { conflictFieldLabel } from "./conflict-fields";
import { formSourceMovedOn, sectionTypeChanged } from "./form-base";
import type { SchemaProperty } from "./resolve-schema";

/**
 * A section form's edit and someone else's change to the same section, when
 * both changed some of the same values to different things. Values only one
 * side changed are merged without asking; for the others the user chooses,
 * value by value, whose version to keep (form-conflict-dialog.tsx), each
 * value starting on "yours". Nothing of the form's is saved until they do.
 */
export interface FormConflictValues {
  /** The section as the form started from (both edits are relative to it). */
  ancestor: Record<string, unknown>;
  /** The form's value: the user's version. */
  mine: Record<string, unknown>;
  /** The section as stored now: their version. */
  theirs: Record<string, unknown>;
}

export interface FormConflictPlan extends FormConflictValues {
  /** Both edits merged, their value kept wherever both changed one. */
  merged: Record<string, unknown>;
  /** JSON pointers of the values both changed to different things. */
  pointers: string[];
}

export type ConflictChoice = "mine" | "theirs";
export type ConflictChoices = Record<string, ConflictChoice>;

/**
 * Merges the user's edit onto the stored section and lists the clashes, value
 * by value: as `mergeBlockJson`, but a list both changed item by item (same
 * length) is compared item by item too, so the dialog can name the item's
 * field ("Slides › 1 › Title") rather than the whole list.
 */
export function planFormConflict(values: FormConflictValues): FormConflictPlan {
  const pointers: string[] = [];
  const merged = mergeValues(
    "",
    values.ancestor,
    values.mine,
    values.theirs,
    pointers,
  ) as Record<string, unknown>;
  return { ...values, merged, pointers };
}

function mergeValues(
  path: string,
  ancestor: unknown,
  mine: unknown,
  theirs: unknown,
  pointers: string[],
): unknown {
  const same = (a: unknown, b: unknown) =>
    canonicalBlockJson(a) === canonicalBlockJson(b);
  if (same(mine, theirs) || same(ancestor, theirs)) return mine;
  if (same(ancestor, mine)) return theirs;
  if (isRecord(mine) && isRecord(theirs)) {
    const base = isRecord(ancestor) ? ancestor : {};
    const merged: Record<string, unknown> = {};
    const keys = [
      ...Object.keys(mine),
      ...Object.keys(theirs).filter((key) => !(key in mine)),
    ];
    for (const key of keys) {
      const value = mergeValues(
        `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`,
        base[key],
        mine[key],
        theirs[key],
        pointers,
      );
      if (value !== undefined) merged[key] = value;
    }
    return merged;
  }
  if (
    Array.isArray(ancestor) &&
    Array.isArray(mine) &&
    Array.isArray(theirs) &&
    mine.length === ancestor.length &&
    theirs.length === ancestor.length
  ) {
    return ancestor.map((item, i) =>
      mergeValues(`${path}/${i}`, item, mine[i], theirs[i], pointers),
    );
  }
  // Their version stands until the user picks.
  pointers.push(path);
  return theirs;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * The section to save once the user chose: everything both edits agree on
 * (or only one changed), and, for each value both changed, the version they
 * picked. A value with no choice keeps theirs (the dialog always sends one).
 */
export function resolveFormConflict(
  plan: FormConflictPlan,
  choices: ConflictChoices,
): Record<string, unknown> {
  let resolved: unknown = plan.merged;
  for (const pointer of plan.pointers) {
    if (choices[pointer] !== "mine") continue;
    resolved = setAtPointer(
      resolved,
      pointer,
      valueAtPointer(plan.mine, pointer),
    );
  }
  return resolved as Record<string, unknown>;
}

/** The same choice for every value in conflict. */
export function chooseAll(
  plan: FormConflictPlan,
  choice: ConflictChoice,
): ConflictChoices {
  return Object.fromEntries(plan.pointers.map((pointer) => [pointer, choice]));
}

/** Where the dialog starts: "yours" for every value in conflict. */
export function defaultConflictChoices(
  plan: FormConflictPlan,
): ConflictChoices {
  return chooseAll(plan, "mine");
}

/**
 * The choices after the plan was made again (their version changed again):
 * a choice is kept for a value still in conflict whose two versions are the
 * ones the user chose between; every other value starts on "yours" again.
 */
export function carryConflictChoices(
  previous: FormConflictPlan,
  choices: ConflictChoices,
  next: FormConflictPlan,
): ConflictChoices {
  const carried = defaultConflictChoices(next);
  for (const pointer of next.pointers) {
    const choice = choices[pointer];
    if (!choice || !previous.pointers.includes(pointer)) continue;
    const unchanged = (["mine", "theirs"] as const).every(
      (side) =>
        canonicalBlockJson(valueAtPointer(previous[side], pointer)) ===
        canonicalBlockJson(valueAtPointer(next[side], pointer)),
    );
    if (unchanged) carried[pointer] = choice;
  }
  return carried;
}

/**
 * How many times each value's "their" version changed while the dialog was
 * open: a step whose count went up since the user last looked at it gets a
 * ring on its dot (form-conflict-dialog.tsx).
 */
export type ConflictFreshness = Readonly<Record<string, number>>;

/**
 * `fresh` with one more change counted for each value of `next` whose "their"
 * version is not the one `previous` showed (a value newly in conflict too).
 */
export function markTheirsChanged(
  previous: FormConflictPlan,
  next: FormConflictPlan,
  fresh: ConflictFreshness = {},
): ConflictFreshness {
  const changed = next.pointers.filter(
    (pointer) =>
      !previous.pointers.includes(pointer) ||
      canonicalBlockJson(valueAtPointer(previous.theirs, pointer)) !==
        canonicalBlockJson(valueAtPointer(next.theirs, pointer)),
  );
  if (changed.length === 0) return fresh;
  return {
    ...fresh,
    ...Object.fromEntries(
      changed.map((pointer) => [pointer, (fresh[pointer] ?? 0) + 1]),
    ),
  };
}

/**
 * A waiting choice against the section as stored now (`nowStored`, null when
 * it can't be found where the form saves): their version becomes the newer
 * copy, the picks whose two versions didn't change are kept, and the dialog
 * says it changed again, counting the values whose "their" version moved
 * (`fresh`). Null when there is nothing to refresh: the same
 * copy, a different kind of section, a version the form itself saved
 * (`isOwn`), or no clash left (the choice then stays as asked: applying it
 * merges onto the newer copy whichever version was picked).
 */
export function refreshWaitingChoice(
  waiting: {
    plan: FormConflictPlan;
    choices: ConflictChoices;
    fresh?: ConflictFreshness;
  },
  nowStored: Record<string, unknown> | null,
  isOwn: (stored: Record<string, unknown>) => boolean,
): {
  plan: FormConflictPlan;
  choices: ConflictChoices;
  fresh: ConflictFreshness;
} | null {
  if (
    !nowStored ||
    sectionTypeChanged(waiting.plan.ancestor, nowStored) ||
    !formSourceMovedOn(waiting.plan.theirs, nowStored) ||
    isOwn(nowStored)
  ) {
    return null;
  }
  const plan = planFormConflict({ ...waiting.plan, theirs: nowStored });
  if (plan.pointers.length === 0) return null;
  return {
    plan,
    choices: carryConflictChoices(waiting.plan, waiting.choices, plan),
    fresh: markTheirsChanged(waiting.plan, plan, waiting.fresh),
  };
}

/** One value in conflict, as the dialog lists it. */
export interface ConflictField {
  pointer: string;
  /** The field as the form labels it ("Slides › 1 › Title"). */
  label: string;
  mine: unknown;
  theirs: unknown;
  /** The field's schema, when the section's schema describes it. */
  schema: SchemaProperty | null;
  /**
   * The value as a whole phrase in the dialog's title, article included
   * ('the A/B test "hero"'), for a value that isn't a form's field: the
   * title then names it alone (no "of {block}").
   */
  phrase?: string;
}

export function conflictFields(
  plan: FormConflictPlan,
  schema?: SchemaProperty | null,
): ConflictField[] {
  return plan.pointers.map((pointer) => ({
    pointer,
    label: conflictFieldLabel(pointer, schema),
    mine: valueAtPointer(plan.mine, pointer),
    theirs: valueAtPointer(plan.theirs, pointer),
    schema: schemaAtPointer(schema ?? null, pointer),
  }));
}

function pointerSteps(pointer: string): string[] {
  return pointer
    .split("/")
    .slice(1)
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
}

/** The value a JSON pointer names in `root` (undefined when absent). */
export function valueAtPointer(root: unknown, pointer: string): unknown {
  let node: unknown = root;
  for (const step of pointerSteps(pointer)) {
    if (Array.isArray(node)) node = node[Number(step)];
    else if (node && typeof node === "object") {
      node = (node as Record<string, unknown>)[step];
    } else return undefined;
  }
  return node;
}

/**
 * `root` with the value at `pointer` replaced (removed when `value` is
 * undefined), copying the objects and arrays on the way so `root` itself is
 * left as it was.
 */
export function setAtPointer(
  root: unknown,
  pointer: string,
  value: unknown,
): unknown {
  const steps = pointerSteps(pointer);
  const write = (node: unknown, depth: number): unknown => {
    if (depth === steps.length) return value;
    const step = steps[depth] as string;
    if (Array.isArray(node)) {
      const copy = [...node];
      copy[Number(step)] = write(node[Number(step)], depth + 1);
      return copy;
    }
    const copy: Record<string, unknown> =
      node && typeof node === "object"
        ? { ...(node as Record<string, unknown>) }
        : {};
    const next = write(copy[step], depth + 1);
    if (next === undefined) delete copy[step];
    else copy[step] = next;
    return copy;
  };
  return write(root, 0);
}

function schemaAtPointer(
  schema: SchemaProperty | null,
  pointer: string,
): SchemaProperty | null {
  let node: SchemaProperty | null | undefined = schema;
  for (const step of pointerSteps(pointer)) {
    if (!node) return null;
    node =
      /^\d+$/.test(step) && !node.properties?.[step]
        ? node.items
        : node.properties?.[step];
  }
  return node ?? null;
}

/** How the dialog shows one version of a value. */
export type ValuePreview =
  | { kind: "empty" }
  | { kind: "text"; text: string }
  | { kind: "image"; src: string }
  | { kind: "yesNo"; value: boolean }
  | { kind: "list"; count: number; items: string[] }
  | { kind: "fields"; entries: Array<{ label: string; text: string }> };

const IMAGE_URL = /\.(png|jpe?g|gif|webp|avif|svg)(\?.*)?$/i;
const SUMMARY_LENGTH = 60;
const LISTED = 3;

function looksLikeImage(text: string, schema: SchemaProperty | null): boolean {
  if (schema?.format === "image-uri") return true;
  return (
    text.startsWith("data:image/") ||
    (/^(https?:)?\/\//.test(text) && IMAGE_URL.test(text))
  );
}

/** Text a person reads from a value: rich text without its tags. */
function plainText(text: string, schema: SchemaProperty | null): string {
  const rich =
    schema?.format === "rich-text" ||
    schema?.format === "rich-text-inline" ||
    schema?.format === "html" ||
    /<\/?[a-z][^>]*>/i.test(text);
  if (!rich) return text;
  // Line breaks for the tags that end a line, then the text the browser would show: the parser
  // drops every tag and decodes every entity once (no regex sanitizing, no double unescaping).
  const marked = text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6])>/gi, "\n");
  return htmlToText(marked)
    .replace(/\u00a0/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

const ENTITIES: Record<string, string> = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
};

/** The text content of an HTML fragment. Shown as text, never as markup. */
function htmlToText(html: string): string {
  if (typeof DOMParser !== "undefined") {
    return (
      new DOMParser().parseFromString(html, "text/html").body.textContent ?? ""
    );
  }
  // No DOM (tests, server): drop tags until none is left, then decode each entity once.
  let out = html;
  for (let previous = ""; previous !== out; ) {
    previous = out;
    out = out.replace(/<[^<>]*>/g, "");
  }
  return out
    .replace(/<|>/g, "")
    .replace(/&(nbsp|amp|lt|gt|quot|#39);/g, (m) => ENTITIES[m] ?? m);
}

function shorten(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > SUMMARY_LENGTH
    ? `${flat.slice(0, SUMMARY_LENGTH - 1)}…`
    : flat;
}

function fileName(src: string): string {
  if (src.startsWith("data:")) return "image";
  const path = src.split(/[?#]/)[0] ?? src;
  return decodeURIComponent(path.split("/").pop() || src);
}

/**
 * One line that names a value: its text, an image's file name, a list's
 * size, an item's title. `labels` words the parts that aren't the user's
 * content.
 */
export function summarizeValue(
  value: unknown,
  schema: SchemaProperty | null,
  labels: ValueLabels,
): string {
  const preview = previewValue(value, schema);
  switch (preview.kind) {
    case "empty":
      return labels.empty;
    case "text":
      return shorten(preview.text);
    case "image":
      return fileName(preview.src);
    case "yesNo":
      return preview.value ? labels.yes : labels.no;
    case "list":
      return labels.items(preview.count);
    case "fields":
      return shorten(
        preview.entries.map((entry) => entry.text).join(" · ") || labels.empty,
      );
  }
}

export interface ValueLabels {
  empty: string;
  yes: string;
  no: string;
  items: (count: number) => string;
}

/** What to show for one version of a value, by its kind. */
export function previewValue(
  value: unknown,
  schema: SchemaProperty | null,
): ValuePreview {
  if (value === undefined || value === null || value === "") {
    return { kind: "empty" };
  }
  if (typeof value === "string") {
    if (looksLikeImage(value, schema)) return { kind: "image", src: value };
    return { kind: "text", text: plainText(value, schema) };
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return { kind: "text", text: String(value) };
  }
  if (typeof value === "boolean") return { kind: "yesNo", value };
  if (Array.isArray(value)) {
    const itemSchema = schema?.items ?? null;
    return {
      kind: "list",
      count: value.length,
      items: value
        .slice(0, LISTED)
        .map((item) => itemTitle(item, itemSchema) ?? ""),
    };
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    // A value wrapped by a loader or a flag (`{ __resolveType, value }`)
    // reads as the value it wraps.
    if ("value" in record && Object.keys(record).length <= 2) {
      return previewValue(record.value, schema?.properties?.value ?? schema);
    }
    const entries = Object.entries(record)
      .filter(([key, inner]) => !key.startsWith("__") && inner !== undefined)
      .flatMap(([key, inner]) => {
        const innerSchema = schema?.properties?.[key] ?? null;
        const preview = previewValue(inner, innerSchema);
        if (preview.kind === "empty") return [];
        const text =
          preview.kind === "text"
            ? shorten(preview.text)
            : preview.kind === "image"
              ? fileName(preview.src)
              : preview.kind === "yesNo"
                ? preview.value
                  ? "✓"
                  : "✗"
                : preview.kind === "list"
                  ? `${preview.count}`
                  : "…";
        return [{ label: innerSchema?.title?.trim() || key, text }];
      })
      .slice(0, 4);
    return entries.length > 0 ? { kind: "fields", entries } : { kind: "empty" };
  }
  return { kind: "text", text: String(value) };
}

/** A list item's title: its `titleBy` field, else its first text field. */
function itemTitle(item: unknown, schema: SchemaProperty | null) {
  if (typeof item === "string") return shorten(plainText(item, schema));
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const record = item as Record<string, unknown>;
  const by = schema?.titleBy;
  const titled = by ? record[by] : undefined;
  if (typeof titled === "string" && titled.trim()) return shorten(titled);
  for (const [key, inner] of Object.entries(record)) {
    if (key.startsWith("__") || typeof inner !== "string" || !inner.trim()) {
      continue;
    }
    if (looksLikeImage(inner, schema?.properties?.[key] ?? null)) continue;
    return shorten(plainText(inner, null));
  }
  return null;
}

/** A stretch of text in a word diff: in both versions, or in one only. */
export interface DiffPart {
  text: string;
  /** "same": in both; "changed": only in the version it is shown in. */
  kind: "same" | "changed";
}

const DIFF_TOKEN_LIMIT = 1500;

/**
 * A word-level comparison of two texts, as each side shows it: the words the
 * other version doesn't have are marked. Long texts are shown whole, unmarked.
 */
export function diffWords(
  mine: string,
  theirs: string,
): { mine: DiffPart[]; theirs: DiffPart[] } {
  const a = mine.split(/(\s+)/).filter((token) => token !== "");
  const b = theirs.split(/(\s+)/).filter((token) => token !== "");
  if (a.length > DIFF_TOKEN_LIMIT || b.length > DIFF_TOKEN_LIMIT) {
    return {
      mine: [{ text: mine, kind: "changed" }],
      theirs: [{ text: theirs, kind: "changed" }],
    };
  }
  // Longest common subsequence of the tokens, filled from the end.
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      const row = lcs[i] as number[];
      row[j] =
        a[i] === b[j]
          ? ((lcs[i + 1] as number[])[j + 1] as number) + 1
          : Math.max(
              (lcs[i + 1] as number[])[j] as number,
              row[j + 1] as number,
            );
    }
  }
  const mineParts: DiffPart[] = [];
  const theirParts: DiffPart[] = [];
  const push = (parts: DiffPart[], text: string, kind: DiffPart["kind"]) => {
    const last = parts.at(-1);
    // Whitespace between two changed words reads as part of the change.
    if (last && (last.kind === kind || (kind === "same" && !text.trim()))) {
      last.text += text;
    } else parts.push({ text, kind });
  };
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push(mineParts, a[i] as string, "same");
      push(theirParts, b[j] as string, "same");
      i++;
      j++;
    } else if (
      ((lcs[i + 1] as number[])[j] as number) >=
      ((lcs[i] as number[])[j + 1] as number)
    ) {
      push(mineParts, a[i] as string, "changed");
      i++;
    } else {
      push(theirParts, b[j] as string, "changed");
      j++;
    }
  }
  for (; i < a.length; i++) push(mineParts, a[i] as string, "changed");
  for (; j < b.length; j++) push(theirParts, b[j] as string, "changed");
  return { mine: mineParts, theirs: theirParts };
}
