import {
  TASK_COMMENT_ATTACHMENT_VOLUME,
  taskCommentAttachmentDir,
} from "@decocms/shared/task-comment-attachments";
import { isImageFile } from "@/components/markdown-editor/uploads";
import { fileExtension } from "@/components/markdown-editor/use-file-upload";
import { useOrgFsDownloadUrl, useOrgFsMutations } from "@/hooks/use-org-fs";
import type { AttachmentLink } from "./comment-attachments";

/**
 * Stores a comment's files in the task's attachment folder. Each upload gets a
 * fresh UUID name — pasted screenshots are all "image.png" — so a file never
 * overwrites another and the server can recognise it in a body by name alone.
 */
export function useCommentAttachmentUpload(taskId: string) {
  const { upload } = useOrgFsMutations(TASK_COMMENT_ATTACHMENT_VOLUME);
  const fileUrl = useOrgFsDownloadUrl(TASK_COMMENT_ATTACHMENT_VOLUME);
  const dir = taskCommentAttachmentDir(taskId);

  return {
    store: async (file: File): Promise<AttachmentLink> => {
      const name = `${crypto.randomUUID()}${fileExtension(file)}`;
      await upload.mutateAsync({
        dir,
        files: [new File([file], name, { type: file.type })],
      });
      return {
        name: file.name,
        url: fileUrl(`${dir}/${name}`),
        isImage: isImageFile(file),
      };
    },
  };
}
