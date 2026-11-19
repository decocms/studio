import { readFileSync, statSync } from "node:fs";

/** Raw bytes; base64 adds a third, which keeps a block under the API's 5 MB. */
export const MAX_IMAGE_BYTES = 3_750_000;
export const MAX_IMAGES_PER_MESSAGE = 20;

export type ImageMediaType =
  | "image/jpeg"
  | "image/png"
  | "image/gif"
  | "image/webp";

export interface ImageBlock {
  type: "image";
  source: { type: "base64"; media_type: ImageMediaType; data: string };
}

/** The media type the bytes actually are; a declared type the API would reject on mismatch. */
function sniffImageType(bytes: Uint8Array): ImageMediaType | null {
  const at = (i: number) => bytes[i] ?? -1;
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47)
    return "image/png";
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38)
    return "image/gif";
  if (
    at(0) === 0x52 &&
    at(1) === 0x49 &&
    at(2) === 0x46 &&
    at(3) === 0x46 &&
    at(8) === 0x57 &&
    at(9) === 0x45 &&
    at(10) === 0x42 &&
    at(11) === 0x50
  )
    return "image/webp";
  return null;
}

/** `- <name>: <path> (tool URL: …)` lines of the attachment annotation, in order. */
export function attachedFilePaths(
  text: string,
): { name: string; path: string }[] {
  const entries: { name: string; path: string }[] = [];
  for (const match of text.matchAll(
    /^- (.+?): (\/app\/org\/upload\/.+?) \(tool URL: .*\)$/gm,
  )) {
    const [, name, path] = match;
    if (name && path) entries.push({ name, path });
  }
  return entries;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whether `stored` is `wanted` or the API's de-duplicated "name (2).ext" of it. */
function sameAttachment(wanted: string, stored: string): boolean {
  const dot = wanted.lastIndexOf(".");
  const stem = dot > 0 ? wanted.slice(0, dot) : wanted;
  const ext = dot > 0 ? wanted.slice(dot) : "";
  return new RegExp(
    `^${escapeRegExp(stem)}( \\(\\d+\\))?${escapeRegExp(ext)}$`,
  ).test(stored);
}

export interface ReadFile {
  size: (path: string) => number;
  read: (path: string) => Uint8Array;
}

const diskFiles: ReadFile = {
  size: (path) => statSync(path).size,
  read: (path) => readFileSync(path),
};

/** Bytes come from the annotated in-pod path, not the part's presigned URL, which can expire before a queued turn sends. */
export function imageBlocksFromUserMessage(
  userMessage: unknown,
  files: ReadFile = diskFiles,
): ImageBlock[] {
  if (typeof userMessage !== "object" || userMessage === null) return [];
  const parts = (userMessage as { parts?: unknown }).parts;
  if (!Array.isArray(parts)) return [];
  const text = parts
    .flatMap((part) =>
      typeof part === "object" &&
      part !== null &&
      (part as { type?: unknown }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string"
        ? [(part as { text: string }).text]
        : [],
    )
    .join("\n");
  const unclaimed = attachedFilePaths(text);
  const blocks: ImageBlock[] = [];
  for (const part of parts) {
    if (blocks.length >= MAX_IMAGES_PER_MESSAGE) break;
    if (typeof part !== "object" || part === null) continue;
    const file = part as {
      type?: unknown;
      mediaType?: unknown;
      filename?: unknown;
    };
    if (
      file.type !== "file" ||
      typeof file.mediaType !== "string" ||
      !file.mediaType.startsWith("image/")
    )
      continue;
    const wanted =
      typeof file.filename === "string" && file.filename.trim()
        ? (file.filename.split(/[\\/]/).pop() ?? file.filename)
        : null;
    const index = unclaimed.findIndex((entry) =>
      wanted
        ? sameAttachment(wanted, entry.name)
        : /^attachment( \(\d+\))?\.\w+$/.test(entry.name),
    );
    if (index === -1) continue;
    const [entry] = unclaimed.splice(index, 1);
    if (!entry) continue;
    try {
      if (files.size(entry.path) > MAX_IMAGE_BYTES) continue;
      const bytes = files.read(entry.path);
      if (bytes.byteLength > MAX_IMAGE_BYTES) continue;
      const mediaType = sniffImageType(bytes);
      if (!mediaType) continue;
      blocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: mediaType,
          data: Buffer.from(bytes).toString("base64"),
        },
      });
    } catch {
      // Unreadable: the path line in the text still points the model at it.
    }
  }
  return blocks;
}
