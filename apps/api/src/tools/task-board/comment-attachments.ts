/**
 * Removing a comment's attached files when it goes away, never on an edit. Each upload sits in its own folder under the
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
  commentAttachmentTaskOf,
  commentAttachmentUrl,
} from "@decocms/shared/task-comment-attachments";
import { mapBounded } from "@decocms/shared/std";
import { getUserId } from "@/core/studio-context";
import type { StudioContext } from "@/core/studio-context";
import { orgFsSandboxPath } from "@/file-storage/mount/provisioning";

/** A markdown link's target. */
const LINK_TARGET = /\]\(([^)\s]+)\)/g;

/**
 * A comment body as a sandboxed run reads it: this task's attachments point at
 * where the pod mounts them, since their URL needs a browser session. Every
 * other link keeps its URL.
 */
export function attachmentsAsSandboxPaths(
  body: string,
  taskId: string,
): string {
  return body.replace(LINK_TARGET, (link, url: string) => {
    const [attachment] = commentAttachmentLinks(url, taskId);
    return attachment?.url === url
      ? `](${orgFsSandboxPath(COMMENT_ATTACHMENT_VOLUME, attachment.path)})`
      : link;
  });
}

const SANDBOX_ROOT = `${orgFsSandboxPath(COMMENT_ATTACHMENT_VOLUME, "")}/`;

/** The inverse, for a body a sandboxed run writes: people get their URLs back,
 *  for any task's attachment the run may have read. */
export function sandboxPathsAsAttachments(
  body: string,
  orgSlug: string,
): string {
  return body.replace(LINK_TARGET, (link, target: string) => {
    const path = target.startsWith(SANDBOX_ROOT)
      ? target.slice(SANDBOX_ROOT.length)
      : "";
    return commentAttachmentTaskOf(path)
      ? `](${commentAttachmentUrl(orgSlug, path)})`
      : link;
  });
}

/** A thread full of screenshots must not fan out into that many storage calls at once. */
const DELETE_CONCURRENCY = 4;

function attachmentFolders(bodies: string[], taskId: string): Set<string> {
  return new Set(
    bodies.flatMap((body) =>
      commentAttachmentPaths(body, taskId).map(commentAttachmentFolder),
    ),
  );
}

/**
 * The upload folders the removed bodies linked that no remaining body does.
 * Compared by folder, not file: a folder is what gets deleted, and a link to
 * any name inside someone's upload folder must not take their file with it.
 */
export function foldersToDelete(
  removedBodies: string[],
  remainingBodies: string[],
  taskId: string,
): string[] {
  const stillLinked = attachmentFolders(remainingBodies, taskId);
  return [...attachmentFolders(removedBodies, taskId)].filter(
    (folder) => !stillLinked.has(folder),
  );
}

/**
 * Delete the attachments the given comment bodies linked to, except any the
 * task still links to elsewhere: someone may have copied the link into
 * another comment or the description. A link from another task doesn't count;
 * it is only a link to this task's file.
 */
export async function deleteCommentAttachments(
  ctx: StudioContext,
  params: { taskId: string; organizationId: string; bodies: string[] },
): Promise<void> {
  const orgFs = ctx.orgFs;
  if (!orgFs) return;
  if (attachmentFolders(params.bodies, params.taskId).size === 0) return;
  try {
    const [comments, description] = await Promise.all([
      ctx.storage.taskBoard.listComments(params.taskId, params.organizationId),
      ctx.storage.taskBoard.getDescription(
        params.taskId,
        params.organizationId,
      ),
    ]);
    const actor = getUserId(ctx) ?? "system";
    await mapBounded(
      foldersToDelete(
        params.bodies,
        [...comments.map((c) => c.body), description ?? ""],
        params.taskId,
      ),
      DELETE_CONCURRENCY,
      (folder) => orgFs.delete(COMMENT_ATTACHMENT_VOLUME, folder, { actor }),
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
