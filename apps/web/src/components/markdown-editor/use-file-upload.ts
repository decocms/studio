import { useState } from "react";
import { toast } from "sonner";
import { useOrgFsDownloadUrl, useOrgFsMutations } from "@/hooks/use-org-fs";
import { useT } from "@/i18n/use-t.ts";
import {
  FILE_DIR,
  IMAGE_DIR,
  isImageFile,
  maxUploadMb,
  UPLOAD_VOLUME,
} from "./uploads";

const EXT_BY_MIME: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/avif": ".avif",
  "image/svg+xml": ".svg",
};

export function fileExtension(file: File): string {
  return (
    file.name.match(/\.[a-z0-9]{1,8}$/i)?.[0] ??
    EXT_BY_MIME[file.type] ??
    // Nothing to go on: an image still needs an extension for the read route to
    // serve it back as one, while an attachment is only ever downloaded.
    (isImageFile(file) ? ".png" : "")
  );
}

/**
 * Uploads editor files to the org filesystem and hands back a same-origin
 * `/api/:org/fs/...` URL. That route is session-authenticated on the same
 * origin, so it renders straight into an `<img>` (or downloads from an `<a>`)
 * for org members while staying private to the org — unlike a public bucket URL.
 */
export function useEditorFileUpload() {
  const t = useT();
  const { upload } = useOrgFsMutations(UPLOAD_VOLUME);
  const fileUrl = useOrgFsDownloadUrl(UPLOAD_VOLUME);
  // A count, not a boolean: pasting three screenshots at once must not clear
  // the indicator as soon as the first one lands.
  const [pending, setPending] = useState(0);

  const uploadFile = async (file: File): Promise<string | null> => {
    const isImage = isImageFile(file);
    const maxMb = maxUploadMb(file);
    if (file.size > maxMb * 1024 * 1024) {
      toast.error(
        t("markdownEditor.fileTooLarge", {
          name: file.name,
          max: String(maxMb),
        }),
      );
      return null;
    }
    // Pasted screenshots are all named "image.png", and the upload path is
    // derived from the file name — reusing it would overwrite another task's
    // file in place.
    const dir = isImage ? IMAGE_DIR : FILE_DIR;
    const name = `${crypto.randomUUID()}${fileExtension(file)}`;
    setPending((n) => n + 1);
    try {
      await upload.mutateAsync({
        dir,
        files: [new File([file], name, { type: file.type })],
      });
      return fileUrl(`${dir}/${name}`);
    } catch {
      toast.error(t("markdownEditor.uploadFailed", { name: file.name }));
      return null;
    } finally {
      setPending((n) => n - 1);
    }
  };

  return { uploadFile, pending };
}
