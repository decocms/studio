import { mapBounded } from "@decocms/shared/std";
import {
  TASK_COMMENT_ATTACHMENT_VOLUME,
  taskCommentAttachmentPaths,
} from "@decocms/shared/task-comment-attachments";
import type { OrgFs } from "@/file-storage/org-fs";

/**
 * The attachments to delete once some of a task's comments are gone.
 *
 * `removed` are the bodies of the comments going away, `kept` everything of
 * the task's that stays (its other comments and its description). A file
 * survives while anything kept still mentions it, in any form — a markdown
 * link, a full URL copied from the browser, a bare URL in prose — so deleting
 * one comment never breaks another that quotes its screenshot. Matching on the
 * file's own name is enough: the composer names every upload with a fresh
 * UUID, which no unrelated text contains.
 */
export function orphanedCommentAttachments(params: {
  taskId: string;
  removed: string[];
  kept: string[];
}): string[] {
  const orphaned = new Set(
    params.removed.flatMap((body) =>
      taskCommentAttachmentPaths(body, params.taskId),
    ),
  );
  return [...orphaned].filter((path) => {
    const name = path.slice(path.lastIndexOf("/") + 1);
    return !params.kept.some((body) => body.includes(name));
  });
}

/** A root with many replies can carry many files; delete a few at a time. */
const DELETE_CONCURRENCY = 4;

/**
 * Delete attachment files or folders from the attachment volume. Best-effort:
 * the comment or task is already gone, so a failure leaves bytes behind and is
 * logged rather than failing the request that removed them.
 */
export async function deleteAttachmentFiles(
  orgFs: OrgFs | null,
  paths: string[],
  actor: string,
): Promise<void> {
  if (!orgFs || paths.length === 0) return;
  await mapBounded(paths, DELETE_CONCURRENCY, async (path) => {
    try {
      await orgFs.delete(TASK_COMMENT_ATTACHMENT_VOLUME, path, { actor });
    } catch (err) {
      console.error("[task-comments] failed to delete attachment", {
        path,
        err,
      });
    }
  });
}
