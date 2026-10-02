/**
 * Where a task comment's attachments live, and how to find them again.
 *
 * A comment body is markdown, so an attachment is stored as a link (or an
 * image) to the org filesystem's read route, the same way the description
 * editor stores its uploads. Each task gets its own folder, so the path alone
 * says which task a file belongs to — a link pasted in from another task is
 * never mistaken for one of this task's attachments.
 */

/** The volume the Library and the description editor already upload to. */
export const TASK_COMMENT_ATTACHMENT_VOLUME = "uploads";

export const TASK_COMMENT_ATTACHMENT_ROOT = "task-comments";

export function taskCommentAttachmentDir(taskId: string): string {
  return `${TASK_COMMENT_ATTACHMENT_ROOT}/${taskId}`;
}

/**
 * The only file name a comment attachment has: the UUID the composer gives it,
 * plus the file's extension. Matching that exact shape, rather than ruling out
 * bad names, keeps anything the file store would decode or resolve further —
 * `\`, `%2e`, `.`, `..`, control characters — from ever being treated as one.
 */
const ATTACHMENT_NAME =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.[a-z0-9]{1,8})?$/i;

/** A relative markdown link target on the read route — `](/api/<org>/fs/<volume>/read?path=<path>)`. */
const READ_LINK_TARGET =
  /\]\(\/api\/[^/\s)]+\/fs\/([^/\s)]+)\/read\?path=([^)\s]+)\)/g;

/**
 * The paths of the task's attachments that a comment body links to, in the
 * order they first appear. Only a file directly inside the task's folder, on
 * the attachment volume, linked by a relative URL counts.
 */
export function taskCommentAttachmentPaths(
  body: string,
  taskId: string,
): string[] {
  const dir = `${taskCommentAttachmentDir(taskId)}/`;
  const paths = new Set<string>();
  for (const [, encodedVolume = "", encodedPath = ""] of body.matchAll(
    READ_LINK_TARGET,
  )) {
    let volume: string;
    let path: string;
    try {
      volume = decodeURIComponent(encodedVolume);
      path = decodeURIComponent(encodedPath);
    } catch {
      continue;
    }
    if (volume !== TASK_COMMENT_ATTACHMENT_VOLUME) continue;
    if (!path.startsWith(dir)) continue;
    if (!ATTACHMENT_NAME.test(path.slice(dir.length))) continue;
    paths.add(path);
  }
  return [...paths];
}
