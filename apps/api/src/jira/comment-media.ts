/**
 * Board-comment images → Jira attachments, so a mirrored comment shows the
 * screenshot instead of a dead link.
 *
 * A task-run agent writes screenshots to the `outputs` volume and references
 * them as `![alt](/api/<org>/fs/outputs/read?path=…)` — a member-gated Studio
 * URL that nobody reading the issue can fetch. This module turns the ones it
 * recognizes into uploads, and `markdownToAdf` embeds them.
 *
 * Only that exact shape, only the `outputs` volume, and only when the org slug
 * in the URL is the pushing org's: a markdown image target is attacker-authored
 * text (an agent writes it), so anything looser would be a way to have Studio
 * copy an arbitrary org file into a customer's Jira. Everything unrecognized
 * stays a link, which is what the converter already does.
 */

import type { AdfMedia } from "./markdown-adf";

/** Jira Cloud's own default attachment ceiling is 10MB; a bigger file would
 *  spend the upload only to be refused. */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** Per comment. A QA pass posts a handful (before/after × viewport); a hundred
 *  is a runaway loop, and each one is a write on the customer's issue. */
const MAX_UPLOADS = 8;

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

export interface OutputsRef {
  volume: string;
  path: string;
}

/**
 * `/api/<org>/fs/outputs/read?path=<encoded>` → the org-fs coordinates, or null
 * for anything else — an absolute URL, another volume, another org's slug.
 */
export function parseOutputsRef(
  target: string,
  orgSlug: string,
): OutputsRef | null {
  if (!target.startsWith("/api/")) return null;
  // Relative, so it needs a base to parse; the base is never used.
  let url: URL;
  try {
    url = new URL(target, "https://studio.invalid");
  } catch {
    return null;
  }
  const segments = url.pathname.split("/");
  const [, api, slug, fs, volume, action] = segments;
  if (
    segments.length !== 6 ||
    api !== "api" ||
    fs !== "fs" ||
    action !== "read" ||
    volume !== "outputs" ||
    slug === undefined ||
    decodeURIComponent(slug) !== orgSlug
  ) {
    return null;
  }
  const path = url.searchParams.get("path");
  if (!path || path.includes("..")) return null;
  return { volume, path };
}

/** The content type for an image path, or null when it is not an image we
 *  would embed (ADF media renders images; a PDF would just be a file card). */
export function imageContentType(path: string): string | null {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_TYPES[extension] ?? null;
}

/**
 * An org-fs path → the attachment filename, flattened and sanitized.
 *
 * Path-derived rather than basename-derived so it stays unique per artifact:
 * two runs both writing `before.png` must not collide, because the filename is
 * also the dedup key against the attachments already on the issue.
 */
export function attachmentName(path: string): string {
  const flattened = path.replace(/^\/+/, "").replace(/\//g, "_");
  const safe = flattened.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[-.]+/, "");
  // Tail, not head: the extension is what Jira reads to render an image.
  return (safe === "" ? "attachment" : safe).slice(-120);
}

export interface CommentMediaDeps {
  /** Bytes at an org-fs path; null when the file is gone. */
  read(ref: OutputsRef): Promise<Uint8Array | null>;
  /** Attachments already on the issue — the dedup source. */
  listAttachments(): Promise<
    Array<{ id: string; filename: string; size: number }>
  >;
  upload(file: {
    name: string;
    bytes: Uint8Array;
    contentType: string;
  }): Promise<{ attachmentId: string; mediaId: string | null }>;
  /** The media id of an attachment already on the issue. */
  mediaIdFor(attachmentId: string): Promise<string | null>;
}

/**
 * Resolve what `markdownToAdf` needs to embed: image target → uploaded media.
 *
 * Fail-open by design, per target: an unreadable file, a failed upload, an
 * unresolvable media id all leave the target out of the map, and the converter
 * keeps it as a link. Losing an inline image is a cosmetic regression; losing
 * the comment is not, and the push step gets no retry.
 */
export async function resolveCommentMedia(
  targets: readonly string[],
  orgSlug: string,
  deps: CommentMediaDeps,
): Promise<Map<string, AdfMedia>> {
  const media = new Map<string, AdfMedia>();
  const refs = new Map<string, OutputsRef>();
  for (const target of new Set(targets)) {
    const ref = parseOutputsRef(target, orgSlug);
    if (ref && imageContentType(ref.path)) refs.set(target, ref);
  }
  if (refs.size === 0) return media;

  const capped = [...refs].slice(0, MAX_UPLOADS);
  if (refs.size > capped.length) {
    console.warn(
      `[jira] comment references ${refs.size} images; embedding the first ${capped.length}, the rest stay links`,
    );
  }

  let existing: Awaited<ReturnType<CommentMediaDeps["listAttachments"]>> = [];
  try {
    existing = await deps.listAttachments();
  } catch (err) {
    // Only costs dedup — a re-referenced screenshot uploads a second time.
    console.warn("[jira] could not list attachments for dedup:", err);
  }

  for (const [target, ref] of capped) {
    try {
      const bytes = await deps.read(ref);
      if (!bytes) continue;
      if (bytes.byteLength > MAX_UPLOAD_BYTES) {
        console.warn(
          `[jira] ${ref.path} is ${bytes.byteLength} bytes, over the ${MAX_UPLOAD_BYTES} upload cap — staying a link`,
        );
        continue;
      }
      const name = attachmentName(ref.path);
      const alt = ref.path.split("/").pop() ?? name;
      const match = existing.find(
        (attachment) =>
          attachment.filename === name && attachment.size === bytes.byteLength,
      );
      const mediaId = match
        ? await deps.mediaIdFor(match.id)
        : (
            await deps.upload({
              name,
              bytes,
              contentType: imageContentType(ref.path) ?? "image/png",
            })
          ).mediaId;
      if (mediaId) media.set(target, { id: mediaId, alt });
    } catch (err) {
      console.warn(
        `[jira] could not attach ${ref.path}, keeping the link:`,
        err,
      );
    }
  }
  return media;
}
