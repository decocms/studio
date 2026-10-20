/**
 * Where the editor's uploads live, and how to recognize one again later.
 *
 * The stored description is markdown, so an upload is nothing but a link (or an
 * image) pointing at the org filesystem. These paths are the only thing that
 * tells one of our uploads apart from a URL the user typed — the markdown
 * parser needs that to turn a file link back into an attachment chip.
 */

import {
  EDITOR_FILE_DIR,
  EDITOR_IMAGE_TYPES,
  EDITOR_UPLOAD_VOLUME,
} from "@decocms/shared/editor-uploads";

/** An image the API serves for one is inlined as a preview; anything else becomes a download chip. */
export function isImageFile(file: File): boolean {
  return EDITOR_IMAGE_TYPES.includes(file.type);
}

const FS_READ_PATH = new RegExp(`^/api/[^/]+/fs/${EDITOR_UPLOAD_VOLUME}/read$`);
/** Only satisfies the URL parser — uploads are stored as relative paths. */
const RELATIVE_BASE = "http://relative.invalid";

/**
 * True for the download URL of a non-image attachment uploaded by this editor
 * (`/api/:org/fs/uploads/read?path=editor-files/…`). Only those render as an
 * attachment chip; every other link stays a plain link.
 */
export function isEditorFileUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url, RELATIVE_BASE);
  } catch {
    return false;
  }
  // A URL carrying its own origin is someone else's file, however much its path
  // looks like ours — don't dress it up as an org attachment.
  if (parsed.origin !== RELATIVE_BASE) return false;
  if (!FS_READ_PATH.test(parsed.pathname)) return false;
  return (parsed.searchParams.get("path") ?? "").startsWith(
    `${EDITOR_FILE_DIR}/`,
  );
}
