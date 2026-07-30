import { useState } from "react";
import { toast } from "sonner";
import { useOrgFsDownloadUrl, useOrgFsMutations } from "@/hooks/use-org-fs";
import { useT } from "@/i18n/use-t.ts";

/** Same volume the Library writes user uploads to. */
const VOLUME = "uploads";
/** Kept out of the Library root so pasted screenshots don't clutter it. */
const DIR = "editor-images";
const MAX_BYTES = 10 * 1024 * 1024;

const EXT_BY_MIME: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/avif": ".avif",
  "image/svg+xml": ".svg",
};

function fileExtension(file: File): string {
  return (
    file.name.match(/\.[a-z0-9]{1,5}$/i)?.[0] ??
    EXT_BY_MIME[file.type] ??
    ".png"
  );
}

export function isImageFile(file: File): boolean {
  return file.type.startsWith("image/");
}

/**
 * Uploads editor images to the org filesystem and hands back a same-origin
 * `/api/:org/fs/...` URL. That route is session-authenticated on the same
 * origin, so it renders straight into an `<img>` for org members while staying
 * private to the org — unlike a public bucket URL.
 */
export function useEditorImageUpload() {
  const t = useT();
  const { upload } = useOrgFsMutations(VOLUME);
  const fileUrl = useOrgFsDownloadUrl(VOLUME);
  // A count, not a boolean: pasting three screenshots at once must not clear
  // the indicator as soon as the first one lands.
  const [pending, setPending] = useState(0);

  const uploadImage = async (file: File): Promise<string | null> => {
    if (file.size > MAX_BYTES) {
      toast.error(t("markdownEditor.imageTooLarge", { name: file.name }));
      return null;
    }
    // Pasted screenshots are all named "image.png", and the upload path is
    // derived from the file name — reusing it would overwrite another task's
    // image in place.
    const name = `${crypto.randomUUID()}${fileExtension(file)}`;
    setPending((n) => n + 1);
    try {
      await upload.mutateAsync({
        dir: DIR,
        files: [new File([file], name, { type: file.type })],
      });
      return fileUrl(`${DIR}/${name}`);
    } catch {
      toast.error(t("markdownEditor.uploadFailed", { name: file.name }));
      return null;
    } finally {
      setPending((n) => n - 1);
    }
  };

  return { uploadImage, pending };
}
