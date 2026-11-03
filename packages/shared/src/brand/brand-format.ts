/**
 * A brand's post formats: one markdown file each, under `formats/` beside its
 * `brand.md`.
 *
 * A format is the brief a writer follows for one shape of post. Flat
 * frontmatter says what it is — `name`, a one-line `summary` an agent chooses
 * by, and an optional `length` — and the body is the brief itself, which the
 * agent copies whole onto the card it writes. A file per format keeps each
 * brief as long as it needs to be, and an edit to one never rewrites the
 * guide.
 *
 * Guides written before this keep their formats as `### Name` blocks in a
 * formats section; `formatsFrom` in `brand-blog.ts` still reads those, for a
 * brand whose `formats/` folder is empty.
 */

import { parseFrontmatterDoc } from "../harness/skill-md";

/** The folder, inside a brand's, that holds its formats. */
export const FORMATS_DIR = "formats";

/** The longest brief a card and the drafting tools carry. */
export const MAX_FORMAT_CHARS = 8_000;

/** How many formats one read returns; more is noise to choose from. */
export const MAX_FORMATS = 20;

export type BrandFormat = {
  /** The file's name without `.md`. A format read off an old guide has none. */
  id?: string;
  name: string;
  /** What the format is for, in one line. */
  summary?: string;
  /** How long a post in it runs, as a person wrote it ("1.200–1.800 palavras"). */
  length?: string;
  /** The brief, in markdown. */
  value: string;
};

/** A file under `formats/` that is not read as a format, and why. */
export type SkippedFormat = {
  id: string;
  reason: "unnamed" | "too-long";
};

const FORMAT_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** `brands/acme/formats/guia.md` → `guia`; null for anything that is not a format file. */
export function formatIdOf(path: string): string | null {
  const base = path.slice(path.lastIndexOf("/") + 1);
  if (!base.endsWith(".md")) return null;
  const id = base.slice(0, -".md".length);
  return FORMAT_ID.test(id) ? id : null;
}

function unquote(value: string): string {
  return value.replace(/^(["'])(.*)\1$/, "$2").trim();
}

/** One format file, or null when its frontmatter names no format. */
export function parseFormatFile(text: string, id: string): BrandFormat | null {
  const { fm, body } = parseFrontmatterDoc(text);
  const name = unquote(fm.name ?? "");
  if (!name) return null;
  const summary = unquote(fm.summary ?? "");
  const length = unquote(fm.length ?? "");
  return {
    id,
    name,
    ...(summary ? { summary } : {}),
    ...(length ? { length } : {}),
    value: body.trim(),
  };
}

const oneLine = (value: string) => value.replace(/\s+/g, " ").trim();

/** A format's file: its frontmatter, then its brief. */
export function formatFileText(format: Omit<BrandFormat, "id">): string {
  const lines = [`name: ${oneLine(format.name)}`];
  if (format.summary?.trim()) lines.push(`summary: ${oneLine(format.summary)}`);
  if (format.length?.trim()) lines.push(`length: ${oneLine(format.length)}`);
  return `---\n${lines.join("\n")}\n---\n\n${format.value.trim()}\n`;
}

/** The id a new format's file takes: its name, accents folded, numbered past the ones taken. */
export function newFormatId(name: string, taken: readonly string[]): string {
  const base =
    name
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60)
      .replace(/-+$/, "") || "format";
  let id = base;
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
  return id;
}
