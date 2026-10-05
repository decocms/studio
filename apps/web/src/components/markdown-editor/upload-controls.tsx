import { useRef } from "react";
import { IconButton } from "@decocms/ui/components/icon-button.tsx";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import { Attachment01 } from "@untitledui/icons";
import { useT } from "@/i18n/use-t.ts";

/** The paperclip and the file picker it opens. */
export function AttachFileButton({
  onFiles,
  disabled,
}: {
  onFiles: (files: File[]) => void;
  disabled?: boolean;
}) {
  const t = useT();
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <>
      <IconButton
        type="button"
        label={t("markdownEditor.attachFile")}
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
      >
        <Attachment01 size={16} />
      </IconButton>
      {/* No `accept`: images preview, anything else becomes a download chip. */}
      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          // Let the same file be picked again after a failed upload.
          e.target.value = "";
          if (files.length > 0) onFiles(files);
        }}
      />
    </>
  );
}

/** How many picked files are still on their way into the document. */
export function UploadStatus({ pending }: { pending: number }) {
  const t = useT();
  if (pending === 0) return null;
  return (
    <span
      className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
      aria-live="polite"
      role="status"
    >
      <Spinner className="size-3" />
      {pending === 1
        ? t("markdownEditor.uploading")
        : t("markdownEditor.uploadingCount", { count: String(pending) })}
    </span>
  );
}
