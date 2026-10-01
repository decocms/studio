/**
 * Stub for `@/layouts/task-board/use-comment-attachment-upload`: the real one
 * writes to the org filesystem through `useProjectContext()`, which doesn't
 * exist under a bare mount. The composer's own behaviour — taking, showing,
 * removing and posting files — is what the CT specs assert. The link carries
 * the file's own name so the posted body is predictable; a file named
 * `fail-…` fails to upload.
 */

import { taskCommentAttachmentDir } from "@decocms/shared/task-comment-attachments";
import type { AttachmentLink } from "@/layouts/task-board/comment-attachments";

export function useCommentAttachmentUpload(taskId: string) {
  return {
    store: async (file: File): Promise<AttachmentLink> => {
      if (file.name.startsWith("fail-")) throw new Error("upload failed");
      const path = `${taskCommentAttachmentDir(taskId)}/${file.name}`;
      return {
        name: file.name,
        url: `/api/acme/fs/uploads/read?path=${encodeURIComponent(path)}`,
        isImage: file.type.startsWith("image/"),
      };
    },
  };
}
