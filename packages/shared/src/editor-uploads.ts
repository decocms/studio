/**
 * Where the task editors (description and comments) store an attached file in
 * the org filesystem. The web editors write here; the API serves these paths
 * inert and points task runs at them, so both sides read the names from here.
 */

/** Same volume the Library writes user uploads to. */
export const EDITOR_UPLOAD_VOLUME = "uploads";
/** Kept out of the Library root so pasted screenshots don't clutter it. */
export const EDITOR_IMAGE_DIR = "editor-images";
/** Attachments shown as a download chip instead of a preview (pdf, docx, …). */
export const EDITOR_FILE_DIR = "editor-files";
