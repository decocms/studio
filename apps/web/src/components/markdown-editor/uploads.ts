/**
 * Where the editor's uploads live, and how to recognize one again later.
 *
 * The stored description is markdown, so an upload is nothing but a link (or an
 * image) pointing at the org filesystem. These paths are the only thing that
 * tells one of our uploads apart from a URL the user typed — the markdown
 * parser needs that to turn a file link back into an attachment chip.
 */

import { TASK_COMMENT_ATTACHMENT_ROOT } from "@decocms/shared/task-comment-attachments";

/** Same volume the Library writes user uploads to. */
export const UPLOAD_VOLUME = "uploads";
/** Kept out of the Library root so pasted screenshots don't clutter it. */
export const IMAGE_DIR = "editor-images";
/** Attachments shown as a download chip instead of a preview (pdf, docx, …). */
export const FILE_DIR = "editor-files";

/** Images are inlined as a preview, so an oversized one is also a huge render. */
const MAX_IMAGE_MB = 10;
/** Attachments are only ever downloaded — a deck or a spec can be bigger. */
const MAX_FILE_MB = 25;

export function isImageFile(file: File): boolean {
  return file.type.startsWith("image/");
}

/** The upload cap for this file, in MB. */
export function maxUploadMb(file: File): number {
  return isImageFile(file) ? MAX_IMAGE_MB : MAX_FILE_MB;
}

const FS_READ_PATH = new RegExp(`^/api/[^/]+/fs/${UPLOAD_VOLUME}/read$`);
/** Only satisfies the URL parser — uploads are stored as relative paths. */
const RELATIVE_BASE = "http://relative.invalid";

/** The uploads-volume path a relative read URL points at, or null for any other URL. */
function uploadPathOf(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url, RELATIVE_BASE);
  } catch {
    return null;
  }
  // A URL carrying its own origin is someone else's file, however much its path
  // looks like ours — don't dress it up as an org attachment.
  if (parsed.origin !== RELATIVE_BASE) return null;
  if (!FS_READ_PATH.test(parsed.pathname)) return null;
  return parsed.searchParams.get("path") ?? "";
}

/**
 * True for the download URL of a non-image attachment uploaded by this editor
 * (`/api/:org/fs/uploads/read?path=editor-files/…`). Only those render as an
 * attachment chip; every other link stays a plain link.
 */
export function isEditorFileUrl(url: string): boolean {
  return uploadPathOf(url)?.startsWith(`${FILE_DIR}/`) ?? false;
}

/**
 * True for a link to a file attached to a task comment, shown as a file chip.
 * A comment's images are markdown images, so a link into its folder is a file.
 */
export function isTaskCommentFileUrl(url: string): boolean {
  return (
    uploadPathOf(url)?.startsWith(`${TASK_COMMENT_ATTACHMENT_ROOT}/`) ?? false
  );
}
