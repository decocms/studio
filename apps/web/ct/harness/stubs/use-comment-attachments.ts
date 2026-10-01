/**
 * CT stub for `@/hooks/use-comment-attachments`.
 *
 * The real hook writes to the org filesystem through `useOrgFsMutations`,
 * which needs `useProjectContext()` and a live backend. Here the composer's
 * own draft/send/rollback logic is under test, so uploads land in a record on
 * `window` the spec reads back. A file whose name starts with `fail` rejects,
 * the way a quota or network error would. The real upload is an e2e concern.
 */

interface CtUploads {
  uploaded: string[];
  removed: string[];
}

declare global {
  interface Window {
    __ctUploads?: CtUploads;
  }
}

function record(): CtUploads {
  window.__ctUploads ??= { uploaded: [], removed: [] };
  return window.__ctUploads;
}

export function useCommentAttachments(taskId: string) {
  return {
    upload: async (file: File) => {
      if (file.name.startsWith("fail")) throw new Error("upload failed");
      const uploads = record();
      const path = `task-comments/${taskId}/u${uploads.uploaded.length}/${file.name}`;
      uploads.uploaded.push(path);
      return {
        path,
        url: `/api/acme/fs/uploads/read?${new URLSearchParams({ path })}`,
      };
    },
    remove: async (paths: string[]) => {
      record().removed.push(...paths);
    },
  };
}
