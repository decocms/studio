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
    // Checked on the decoded value, where `%2F` has become a real slash.
    const name = path.slice(dir.length);
    if (name === "" || name.includes("/") || name === "..") continue;
    paths.add(path);
  }
  return [...paths];
}
