import { useState } from "react";
import { toast } from "sonner";
import { LAST_CONFIG_KEY } from "@/components/file-picker/file-picker-dialog";
import { matchSiteSlugConfig } from "@/components/file-picker/match-site-slug-config";
import { useFileConfigsQuery } from "@/hooks/use-file-configs";
import { useFilePickerUpload } from "@/hooks/use-file-picker";
import { useT } from "@/i18n/use-t.ts";
import { resolveTargetConfigId } from "./resolve-target-config-id";

const ACCEPTED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "image/avif",
]);

/**
 * Upload + drag-and-drop plumbing for an image slot, shared by the form field
 * ({@link ImageField}) and the inline post-body image block. Both surfaces
 * must resolve the same bucket, honour the same site-slug lock, and fall back
 * to the picker the same way; only their chrome differs.
 */
export function useImageUpload({
  siteSlug,
  onUploaded,
  onNeedsPicker,
}: {
  siteSlug?: string | null;
  onUploaded: (publicUrl: string) => void;
  /** No deterministic bucket — the caller opens the picker to choose one. */
  onNeedsPicker: () => void;
}) {
  const t = useT();
  const configsQuery = useFileConfigsQuery();
  const upload = useFilePickerUpload();
  const [isDragging, setIsDragging] = useState(false);
  const lockedConfig = matchSiteSlugConfig(
    configsQuery.data?.configs ?? [],
    siteSlug,
  );

  async function handleFiles(files: FileList | File[] | null) {
    if (!files) return;
    const list = Array.from(files).filter((f) =>
      ACCEPTED_IMAGE_TYPES.has(f.type || ""),
    );
    if (list.length === 0) {
      toast.error(t("sectionsEditor.imageField.onlyImageFilesAccepted"));
      return;
    }

    const targetConfigId = resolveTargetConfigId(
      configsQuery.data?.configs ?? [],
      lockedConfig?.id,
      typeof window !== "undefined"
        ? window.localStorage.getItem(LAST_CONFIG_KEY)
        : null,
    );
    if (!targetConfigId) {
      onNeedsPicker();
      return;
    }

    try {
      const result = await upload.mutateAsync({
        configId: targetConfigId,
        file: list[0]!,
      });
      onUploaded(result.publicUrl);
      if (list.length > 1) {
        toast.info(
          t("sectionsEditor.imageField.uploadedWithExtraFilesIgnored", {
            fileName: list[0]!.name,
          }),
        );
      }
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : t("sectionsEditor.imageField.uploadFailed"),
      );
    }
  }

  return {
    isDragging,
    isPending: upload.isPending,
    lockedConfigId: lockedConfig?.id ?? null,
    handleFiles,
    dropProps: {
      onDragOver: (e: React.DragEvent) => {
        e.preventDefault();
        if (e.dataTransfer.types.includes("Files")) setIsDragging(true);
      },
      onDragLeave: (e: React.DragEvent) => {
        // Only clear when leaving the wrapper, not when dragging over a child.
        if (e.currentTarget === e.target) setIsDragging(false);
      },
      onDrop: (e: React.DragEvent) => {
        e.preventDefault();
        // Keep the drop off the chat composer's window-level listener.
        e.stopPropagation();
        setIsDragging(false);
        handleFiles(e.dataTransfer.files);
      },
    },
  };
}
