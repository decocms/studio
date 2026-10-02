/**
 * Stub for `@/components/markdown-editor/use-file-upload`: the real one PUTs to
 * the org filesystem through `useProjectContext()`, which a bare mount lacks.
 * Specs assert what an editor does with an uploaded file, so this returns the
 * URL shape the real upload does, derived from the name to stay deterministic.
 *
 * A name starting with `hold-` stays in flight until the page dispatches
 * `ct:release-uploads`, so a spec can act while an upload is pending.
 */

import {
  EDITOR_FILE_DIR,
  EDITOR_IMAGE_DIR,
} from "@decocms/shared/editor-uploads";
import { isImageFile } from "@/components/markdown-editor/uploads";

const held: Array<() => void> = [];
window.addEventListener("ct:release-uploads", () => {
  for (const release of held.splice(0)) release();
});

export function useEditorFileUpload() {
  const uploadFile = async (file: File): Promise<string | null> => {
    if (file.name.startsWith("hold-")) {
      await new Promise<void>((resolve) => held.push(resolve));
    }
    const dir = isImageFile(file) ? EDITOR_IMAGE_DIR : EDITOR_FILE_DIR;
    return `/api/acme/fs/uploads/read?path=${encodeURIComponent(`${dir}/${file.name}`)}`;
  };
  return { uploadFile };
}
