/**
 * Where a task comment's attachments live, and how to find them again.
 *
 * A comment body is markdown, so an attachment is nothing but a link (or an
 * image) pointing at the org filesystem's read route. Keeping every one under
 * its task's own folder is what lets a delete remove exactly the files that
 * comment posted, and never a description image or another task's file that
 * someone linked to.
 */

/** Same volume the Library and the description editor write uploads to. */
export const COMMENT_ATTACHMENT_VOLUME = "uploads";

/** Parent of every task's attachment folder. */
export const COMMENT_ATTACHMENT_ROOT = "task-comments";

/** The folder holding every file attached to one task's comments. */
export function commentAttachmentDir(taskId: string): string {
  return `${COMMENT_ATTACHMENT_ROOT}/${taskId}`;
}

/** The only characters a stored segment is ever written with. */
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

function isSafeSegment(segment: string): boolean {
  return SAFE_SEGMENT.test(segment) && segment !== "." && segment !== "..";
}

const MAX_STORED_NAME_LENGTH = 100;

/**
 * The file name as the Library shows it. The chip keeps the original name from
 * the link text, so this only has to stay readable and safe to put in a path.
 */
function storedName(fileName: string): string {
  const safe = fileName
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-");
  if (!isSafeSegment(safe)) return "file";
  if (safe.length <= MAX_STORED_NAME_LENGTH) return safe;
  const extension = safe.match(/\.[A-Za-z0-9]{1,8}$/)?.[0] ?? "";
  return safe.slice(0, MAX_STORED_NAME_LENGTH - extension.length) + extension;
}

/** Where one upload goes: its own folder, so two files named `image.png` never collide. */
export function commentAttachmentPath(
  taskId: string,
  fileName: string,
): string {
  return `${commentAttachmentDir(taskId)}/${crypto.randomUUID()}/${storedName(fileName)}`;
}

/** The folder an upload sits alone in, so removing it removes the upload. */
export function commentAttachmentFolder(path: string): string {
  return path.slice(0, path.lastIndexOf("/"));
}

/** Whether a path is one of this task's uploads, exactly as `commentAttachmentPath` writes it. */
export function isCommentAttachmentPath(path: string, taskId: string): boolean {
  const folder = `${commentAttachmentDir(taskId)}/`;
  if (!path.startsWith(folder)) return false;
  const segments = path.slice(folder.length).split("/");
  return segments.length === 2 && segments.every(isSafeSegment);
}

/** The read URL people's browsers load an attachment from. */
export function commentAttachmentUrl(orgSlug: string, path: string): string {
  return `/api/${encodeURIComponent(orgSlug)}/fs/${COMMENT_ATTACHMENT_VOLUME}/read?${new URLSearchParams({ path })}`;
}

// The read URL the web client stores: `/api/:org/fs/uploads/read?path=…`.
const READ_URL = new RegExp(
  `/api/[^/\\s)]+/fs/${COMMENT_ATTACHMENT_VOLUME}/read\\?path=([^)\\s]+)`,
  "g",
);

/** Every link in a comment body to one of this task's attachments, as written. */
export function commentAttachmentLinks(
  body: string,
  taskId: string,
): { url: string; path: string }[] {
  return [...body.matchAll(READ_URL)].flatMap((match) => {
    const path = new URLSearchParams(`path=${match[1]}`).get("path") ?? "";
    return isCommentAttachmentPath(path, taskId)
      ? [{ url: match[0], path }]
      : [];
  });
}

/** The paths, in the uploads volume, of this task's files a comment links to. */
export function commentAttachmentPaths(body: string, taskId: string): string[] {
  return [
    ...new Set(commentAttachmentLinks(body, taskId).map((link) => link.path)),
  ];
}
