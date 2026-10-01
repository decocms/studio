/**
 * Uploads a task comment's attachments when it is sent, so an abandoned draft
 * leaves nothing in the Library, and takes back the rest of a send whose
 * upload failed. A post that fails keeps its uploads for the retry: it may
 * have been saved even though the response was lost.
 */

import {
  COMMENT_ATTACHMENT_VOLUME,
  commentAttachmentFolder,
  commentAttachmentPath,
} from "@decocms/shared/task-comment-attachments";
import { useOrgFsDownloadUrl, useOrgFsMutations } from "@/hooks/use-org-fs";

export function useCommentAttachments(taskId: string) {
  const { upload, remove } = useOrgFsMutations(COMMENT_ATTACHMENT_VOLUME);
  const fileUrl = useOrgFsDownloadUrl(COMMENT_ATTACHMENT_VOLUME);

  return {
    /** Upload one file and say where it went; throws when it didn't land. */
    upload: async (file: File) => {
      const path = commentAttachmentPath(taskId, file.name, file.type);
      const dir = commentAttachmentFolder(path);
      await upload.mutateAsync({
        dir,
        files: [
          new File([file], path.slice(dir.length + 1), { type: file.type }),
        ],
      });
      return { path, url: fileUrl(path) };
    },
    /** Remove uploads whose comment was never posted. Best-effort. */
    remove: async (paths: string[]) => {
      await Promise.allSettled(
        paths.map((path) => remove.mutateAsync(commentAttachmentFolder(path))),
      );
    },
  };
}
