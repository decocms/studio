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
    decodeSegment(slug) !== orgSlug
  ) {
    return null;
  }
  const path = url.searchParams.get("path");
  if (!path || path.includes("..")) return null;
  return { volume, path };
}

/** `decodeURIComponent` throws a `URIError` on a malformed escape like `%zz`,
 *  and this runs in a workflow body, outside any step — an agent writing one
 *  in a comment would fail the whole push. */
function decodeSegment(segment: string | undefined): string | null {
  if (segment === undefined) return null;
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
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

export interface PlannedAttachment {
  /** The image target as written in the markdown — the converter's map key. */
  target: string;
  ref: OutputsRef;
  /** Filename on the issue, and the dedup key against what is already there. */
  name: string;
}

/**
 * Which image targets to attach, and under what name.
 *
 * Pure and deterministic, because the push workflow turns each entry into its
 * own durable step: the same comment body must always plan the same
 * attachments in the same order, or a replay would not line up with the steps
 * already checkpointed.
 */
export function plannedAttachments(
  targets: readonly string[],
  orgSlug: string,
): PlannedAttachment[] {
  const planned: PlannedAttachment[] = [];
  const seen = new Set<string>();
  for (const target of targets) {
    if (seen.has(target)) continue;
    seen.add(target);
    const ref = parseOutputsRef(target, orgSlug);
    if (!ref || !imageContentType(ref.path)) continue;
    planned.push({ target, ref, name: attachmentName(ref.path) });
  }
  if (planned.length > MAX_UPLOADS) {
    console.warn(
      `[jira] comment references ${planned.length} images; embedding the first ${MAX_UPLOADS}, the rest stay links`,
    );
  }
  return planned.slice(0, MAX_UPLOADS);
}

/**
 * One planned image → what the converter needs to embed it, or null to leave
 * it a link.
 *
 * Null is for the outcomes a retry cannot improve: the file is gone, it is
 * over the upload cap, or Jira never yielded a media id. Everything else
 * throws, so the surrounding step retries — safe because the dedup lookup
 * makes a re-run find its own earlier upload instead of duplicating it, which
 * is the property that lets this run as a retriable step at all.
 */
export async function attachImage(
  item: PlannedAttachment,
  deps: CommentMediaDeps,
): Promise<AdfMedia | null> {
  const bytes = await deps.read(item.ref);
  if (!bytes) return null;
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    console.warn(
      `[jira] ${item.ref.path} is ${bytes.byteLength} bytes, over the ${MAX_UPLOAD_BYTES} upload cap — staying a link`,
    );
    return null;
  }
  const existing = await deps
    .listAttachments()
    // Only costs dedup: a re-referenced screenshot uploads a second time.
    .catch((err) => {
      console.warn("[jira] could not list attachments for dedup:", err);
      return [];
    });
  const match = existing.find(
    (attachment) =>
      attachment.filename === item.name && attachment.size === bytes.byteLength,
  );
  const mediaId = match
    ? await deps.mediaIdFor(match.id)
    : (
        await deps.upload({
          name: item.name,
          bytes,
          contentType: imageContentType(item.ref.path) ?? "image/png",
        })
      ).mediaId;
  const alt = item.ref.path.split("/").pop() ?? item.name;
  return mediaId ? { id: mediaId, alt } : null;
}
