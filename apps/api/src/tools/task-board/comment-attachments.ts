/**
 * Removing the files a task comment attached, when the comment (or the part of
 * it an edit took out) goes away. Each upload sits in its own folder under the
 * task's (see `@decocms/shared/task-comment-attachments`), so that folder is
 * what gets deleted.
 *
 * Best-effort, like the other org-fs cleanups: the comment is already gone,
 * so a storage hiccup is logged and leaves an orphan rather than failing the
 * person's delete.
 */

import {
  COMMENT_ATTACHMENT_VOLUME,
  commentAttachmentDir,
  commentAttachmentFolder,
  commentAttachmentLinks,
  commentAttachmentPaths,
  commentAttachmentUrl,
  isCommentAttachmentPath,
} from "@decocms/shared/task-comment-attachments";
import { mapBounded } from "@decocms/shared/std";
import { getUserId } from "@/core/studio-context";
import type { StudioContext } from "@/core/studio-context";
import { orgFsSandboxPath } from "@/file-storage/mount/provisioning";

/**
 * A comment body as a sandboxed run reads it: this task's attachments point at
 * where the pod mounts them, since their URL needs a browser session. Every
 * other link keeps its URL.
 */
export function attachmentsAsSandboxPaths(
  body: string,
  taskId: string,
): string {
  return commentAttachmentLinks(body, taskId).reduce(
    (text, link) =>
      text.replaceAll(
        link.url,
        orgFsSandboxPath(COMMENT_ATTACHMENT_VOLUME, link.path),
      ),
    body,
  );
}

const SANDBOX_LINK = new RegExp(
  `\\]\\(${orgFsSandboxPath(COMMENT_ATTACHMENT_VOLUME, "").replace(/\./g, "\\.")}/([^)\\s]+)\\)`,
  "g",
);

/** The inverse, for a body a sandboxed run writes: people get their URLs back. */
export function sandboxPathsAsAttachments(
  body: string,
  taskId: string,
  orgSlug: string,
): string {
  return body.replace(SANDBOX_LINK, (link, path: string) =>
    isCommentAttachmentPath(path, taskId)
      ? `](${commentAttachmentUrl(orgSlug, path)})`
      : link,
  );
}

/** A thread full of screenshots must not fan out into that many storage calls at once. */
const DELETE_CONCURRENCY = 4;

/**
 * Delete the attachments the given comment bodies linked to, except any the
 * task still links to elsewhere: someone may have copied the link into
 * another comment or the description.
 */
export async function deleteCommentAttachments(
  ctx: StudioContext,
  params: { taskId: string; organizationId: string; bodies: string[] },
): Promise<void> {
  const orgFs = ctx.orgFs;
  if (!orgFs) return;
  const removed = new Set(
    params.bodies.flatMap((body) =>
      commentAttachmentPaths(body, params.taskId),
    ),
  );
  if (removed.size === 0) return;
  try {
    const [comments, description] = await Promise.all([
      ctx.storage.taskBoard.listComments(params.taskId, params.organizationId),
      ctx.storage.taskBoard.getDescription(
        params.taskId,
        params.organizationId,
      ),
    ]);
    const stillLinked = new Set(
      [...comments.map((c) => c.body), description ?? ""].flatMap((body) =>
        commentAttachmentPaths(body, params.taskId),
      ),
    );
    const actor = getUserId(ctx) ?? "system";
    await mapBounded(
      [...removed].filter((path) => !stillLinked.has(path)),
      DELETE_CONCURRENCY,
      (path) =>
        orgFs.delete(COMMENT_ATTACHMENT_VOLUME, commentAttachmentFolder(path), {
          actor,
        }),
    );
  } catch (err) {
    console.error("[task-comments] failed to delete attachments", {
      taskId: params.taskId,
      err,
    });
  }
}

/** Delete every file attached to a deleted task's comments. */
export async function deleteTaskCommentAttachments(
  ctx: StudioContext,
  taskId: string,
): Promise<void> {
  if (!ctx.orgFs) return;
  try {
    await ctx.orgFs.delete(
      COMMENT_ATTACHMENT_VOLUME,
      commentAttachmentDir(taskId),
      { actor: getUserId(ctx) ?? "system" },
    );
  } catch (err) {
    console.error("[task-comments] failed to delete attachments", {
      taskId,
      err,
    });
  }
}
