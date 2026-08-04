import { useState } from "react";
import { Image01, Trash01, Upload01 } from "@untitledui/icons";
import { toast } from "sonner";
import { Button } from "@deco/ui/components/button.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { useT } from "@/i18n/use-t.ts";
import {
  FilePickerDialog,
  LAST_CONFIG_KEY,
} from "@/components/file-picker/file-picker-dialog";
import { matchSiteSlugConfig } from "@/components/file-picker/match-site-slug-config";
import { useFileConfigsQuery } from "@/hooks/use-file-configs";
import { useFilePickerUpload } from "@/hooks/use-file-picker";
import { ClickToReplaceOverlay } from "./click-to-replace-overlay";
import { extractUrl } from "./extract-url";
import { FieldLabel } from "./field-label";
import type { FieldProps } from "./field-props";
import { basename, extension } from "./media-filename";
import { MediaTransformControls } from "./media-transform-controls";
import { resolveTargetConfigId } from "./resolve-target-config-id";

const ACCEPTED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "image/avif",
]);

export function ImageField({
  schema,
  value,
  onChange,
  path,
  label,
  sandbox,
}: FieldProps) {
  const t = useT();
  const strValue = extractUrl(value);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [imageLoaded, setImageLoaded] = useState(false);
  const [imageErrored, setImageErrored] = useState(false);
  const fileName = strValue ? basename(strValue) : "";
  const ext = fileName ? extension(fileName) : "";

  const configsQuery = useFileConfigsQuery();
  const upload = useFilePickerUpload();
  const lockedConfig = matchSiteSlugConfig(
    configsQuery.data?.configs ?? [],
    sandbox?.siteSlug,
  );

  /**
   * Reset the load/error tracking when the underlying URL changes. Used
   * by every code path that swaps the value — input, picker, drop, trash.
   * Without this, a single failed load would conditionally unmount the
   * <img> permanently and the field would be stuck on "Preview
   * unavailable" forever (also why the <img> below has key={strValue}
   * — belt-and-suspenders).
   */
  function setValue(next: string) {
    setImageLoaded(false);
    setImageErrored(false);
    onChange(next);
  }

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
      // No deterministic target — defer to the dialog so the user can
      // pick a bucket (or be guided to configure one). The dialog won't
      // auto-upload; the user does it again inside.
      setPickerOpen(true);
      return;
    }

    try {
      const result = await upload.mutateAsync({
        configId: targetConfigId,
        file: list[0]!,
      });
      setValue(result.publicUrl);
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

  function onDragOver(e: React.DragEvent) {
    e.preventDefault();
    if (e.dataTransfer.types.includes("Files")) setIsDragging(true);
  }
  function onDragLeave(e: React.DragEvent) {
    // Only clear when leaving the wrapper, not when dragging over a child.
    if (e.currentTarget === e.target) setIsDragging(false);
  }
  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setIsDragging(false);
    handleFiles(e.dataTransfer.files);
  }

  return (
    // grid-cols-[minmax(0,1fr)] forces every child to be at most 100% of
    // the grid, no matter what intrinsic-content sizing tries to do —
    // the only reliable way to bulletproof a deeply-nested form field
    // against a misbehaving min-w-0 chain. No `overflow-hidden` here: it
    // clips the input/button focus rings and right borders (cutting off the
    // URL input + Browse button); the grid track already caps width.
    <div className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)] gap-2">
      <div className="min-w-0">
        <FieldLabel
          htmlFor={path}
          label={label}
          description={schema.description}
          labelClassName="text-muted-foreground"
          virtualMcpId={sandbox?.virtualMcpId}
        />
      </div>

      <div
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className={cn(
          "group relative w-full overflow-hidden rounded-xl border border-border/60 bg-muted/30 transition",
          isDragging && "border-primary ring-2 ring-primary/30",
          upload.isPending && "pointer-events-none opacity-60",
        )}
      >
        {strValue ? (
          <>
            <button
              type="button"
              onClick={() => setPickerOpen(true)}
              aria-label={t("sectionsEditor.imageField.replaceImage")}
              className="relative block h-40 w-full cursor-pointer bg-[image:linear-gradient(45deg,rgba(0,0,0,0.04)_25%,transparent_25%,transparent_75%,rgba(0,0,0,0.04)_75%),linear-gradient(45deg,rgba(0,0,0,0.04)_25%,transparent_25%,transparent_75%,rgba(0,0,0,0.04)_75%)] bg-[position:0_0,8px_8px] [background-size:16px_16px]"
            >
              {!imageErrored && (
                <img
                  // Remount whenever the URL changes so onLoad/onError
                  // wire up fresh for the new src — without this the
                  // load/error tracking can stick to the prior value.
                  key={strValue}
                  src={strValue}
                  alt={label}
                  className={cn(
                    "h-full w-full object-contain transition-opacity",
                    !imageLoaded && "opacity-0",
                  )}
                  onLoad={() => setImageLoaded(true)}
                  onError={() => setImageErrored(true)}
                />
              )}
              {imageErrored && (
                <div className="flex h-full w-full flex-col items-center justify-center gap-1 text-muted-foreground">
                  <Image01 size={20} />
                  <p className="text-xs">
                    {t("sectionsEditor.imageField.previewUnavailable")}
                  </p>
                </div>
              )}
              {!imageLoaded && !imageErrored && (
                <div className="absolute inset-0 animate-pulse bg-muted/60" />
              )}
              <ClickToReplaceOverlay />
            </button>
            <div className="flex items-center gap-2 border-t border-border/60 bg-background/50 px-3 py-2">
              <span className="min-w-0 flex-1 truncate text-xs font-medium">
                {fileName}
              </span>
              {ext && (
                <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase text-muted-foreground">
                  {ext}
                </span>
              )}
            </div>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            className="flex h-40 w-full flex-col items-center justify-center gap-2 text-sm text-muted-foreground hover:bg-muted/60 hover:text-foreground"
          >
            <Image01 size={20} />
            <span className="text-sm font-medium">
              {upload.isPending
                ? t("sectionsEditor.imageField.uploading")
                : t("sectionsEditor.imageField.dropImageOrClickToBrowse")}
            </span>
            <span className="text-xs text-muted-foreground">
              {t("sectionsEditor.imageField.supportedFormatsAndSize")}
            </span>
          </button>
        )}

        {isDragging && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-primary/10 backdrop-blur-[1px]">
            <span className="rounded-md bg-background px-3 py-1.5 text-xs font-medium shadow">
              {t("sectionsEditor.imageField.dropToUpload")}
            </span>
          </div>
        )}
      </div>

      <div className="flex w-full min-w-0 items-center gap-2">
        <Input
          id={path}
          type="url"
          value={strValue}
          onChange={(e) => setValue(e.target.value)}
          placeholder={t("sectionsEditor.imageField.urlPlaceholder")}
          className="h-9 min-w-0 flex-1"
        />
        {!strValue && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setPickerOpen(true)}
            className="h-9 shrink-0"
          >
            <Upload01 size={14} />
            {t("sectionsEditor.imageField.browse")}
          </Button>
        )}
        {strValue && (
          <>
            <MediaTransformControls value={strValue} onChange={setValue} />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setValue("")}
              className="h-9 shrink-0"
              aria-label={t("sectionsEditor.imageField.removeImage")}
            >
              <Trash01 size={14} />
            </Button>
          </>
        )}
      </div>

      <FilePickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        mode="image"
        onSelect={(url) => setValue(url)}
        lockedConfigId={lockedConfig?.id ?? null}
      />
    </div>
  );
}
