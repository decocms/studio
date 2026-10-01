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
  commentAttachmentPaths,
} from "@decocms/shared/task-comment-attachments";
import { getUserId } from "@/core/studio-context";
import type { StudioContext } from "@/core/studio-context";

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
    const [comments, task] = await Promise.all([
      ctx.storage.taskBoard.listComments(params.taskId, params.organizationId),
      ctx.storage.taskBoard.getById(params.taskId, params.organizationId),
    ]);
    const stillLinked = new Set(
      [...comments.map((c) => c.body), task?.description ?? ""].flatMap(
        (body) => commentAttachmentPaths(body, params.taskId),
      ),
    );
    const actor = getUserId(ctx) ?? "system";
    await Promise.all(
      [...removed]
        .filter((path) => !stillLinked.has(path))
        .map((path) =>
          orgFs.delete(
            COMMENT_ATTACHMENT_VOLUME,
            commentAttachmentFolder(path),
            { actor },
          ),
        ),
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
