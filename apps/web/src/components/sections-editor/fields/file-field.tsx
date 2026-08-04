import { useState } from "react";
import { File02, Film01, Trash01, Upload01 } from "@untitledui/icons";
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

function ExtBadge({ ext }: { ext: string }) {
  if (!ext) return null;
  return (
    <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase text-muted-foreground">
      {ext}
    </span>
  );
}

export function FileField({
  schema,
  value,
  onChange,
  path,
  label,
  sandbox,
}: FieldProps) {
  const t = useT();
  const isVideo = schema.format === "video-uri";
  const strValue = extractUrl(value);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const fileName = strValue ? basename(strValue) : "";
  const ext = fileName ? extension(fileName) : "";

  const configsQuery = useFileConfigsQuery();
  const upload = useFilePickerUpload();
  const lockedConfig = matchSiteSlugConfig(
    configsQuery.data?.configs ?? [],
    sandbox?.siteSlug,
  );

  function resolveTargetConfigId(): string | null {
    if (lockedConfig) return lockedConfig.id;
    const configs = configsQuery.data?.configs ?? [];
    if (configs.length === 1) return configs[0]!.id;
    if (configs.length === 0) return null;
    const lastSelected =
      typeof window !== "undefined"
        ? window.localStorage.getItem(LAST_CONFIG_KEY)
        : null;
    return configs.some((c) => c.id === lastSelected) ? lastSelected : null;
  }

  async function handleFiles(files: FileList | File[] | null) {
    if (!files) return;
    let list = Array.from(files);
    if (list.length === 0) return;
    if (isVideo) {
      list = list.filter((f) => f.type.startsWith("video/"));
      if (list.length === 0) {
        toast.error(t("sectionsEditor.fileField.videoFileError"));
        return;
      }
    }

    const targetConfigId = resolveTargetConfigId();
    if (!targetConfigId) {
      setPickerOpen(true);
      return;
    }

    try {
      const result = await upload.mutateAsync({
        configId: targetConfigId,
        file: list[0]!,
      });
      onChange(result.publicUrl);
      if (list.length > 1) {
        toast.info(
          t("sectionsEditor.fileField.multiFileWarning", {
            fileName: list[0]!.name,
          }),
        );
      }
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : t("sectionsEditor.fileField.uploadFailed"),
      );
    }
  }

  function onDragOver(e: React.DragEvent) {
    e.preventDefault();
    if (e.dataTransfer.types.includes("Files")) setIsDragging(true);
  }
  function onDragLeave(e: React.DragEvent) {
    if (e.currentTarget === e.target) setIsDragging(false);
  }
  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setIsDragging(false);
    handleFiles(e.dataTransfer.files);
  }

  return (
    // See ImageField for the grid-cols-[minmax(0,1fr)] rationale —
    // bulletproofs against any broken min-w-0 chain above. No
    // `overflow-hidden`: it clips the input/button focus rings and right
    // borders; the grid track already caps width.
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
          isVideo ? (
            <>
              <button
                type="button"
                onClick={() => setPickerOpen(true)}
                aria-label={t("sectionsEditor.fileField.replaceVideoLabel")}
                className="relative block h-40 w-full cursor-pointer overflow-hidden bg-black"
              >
                <video
                  key={strValue}
                  src={strValue}
                  preload="metadata"
                  className="h-full w-full object-contain"
                />
                <ClickToReplaceOverlay />
              </button>
              <div className="flex items-center gap-2 border-t border-border/60 bg-background/50 px-3 py-2">
                <Film01 size={14} className="shrink-0 text-muted-foreground" />
                <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                  {fileName}
                </p>
                <ExtBadge ext={ext} />
              </div>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setPickerOpen(true)}
              aria-label={t("sectionsEditor.fileField.replaceFileLabel")}
              className="flex w-full cursor-pointer items-center gap-3 px-3 py-2.5 text-left hover:bg-muted/60"
            >
              <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-background">
                <File02 size={18} className="text-muted-foreground" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{fileName}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {strValue}
                </p>
              </div>
              <ExtBadge ext={ext} />
            </button>
          )
        ) : (
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            className="flex w-full flex-col items-center justify-center gap-2 py-8 text-sm text-muted-foreground hover:bg-muted/60 hover:text-foreground"
          >
            {isVideo ? <Film01 size={20} /> : <File02 size={20} />}
            <span className="text-sm font-medium">
              {upload.isPending
                ? t("sectionsEditor.fileField.uploading")
                : isVideo
                  ? t("sectionsEditor.fileField.dropVideoHint")
                  : t("sectionsEditor.fileField.dropFileHint")}
            </span>
            <span className="text-xs text-muted-foreground">
              {t("sectionsEditor.fileField.sizeLimit")}
            </span>
          </button>
        )}

        {isDragging && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-primary/10 backdrop-blur-[1px]">
            <span className="rounded-md bg-background px-3 py-1.5 text-xs font-medium shadow">
              {t("sectionsEditor.fileField.dropToUpload")}
            </span>
          </div>
        )}
      </div>

      <div className="flex w-full min-w-0 items-center gap-2">
        <Input
          id={path}
          type="url"
          value={strValue}
          onChange={(e) => onChange(e.target.value)}
          placeholder="https://..."
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
            {t("sectionsEditor.fileField.browseButton")}
          </Button>
        )}
        {isVideo && strValue && (
          <MediaTransformControls
            value={strValue}
            onChange={onChange}
            showMuted
          />
        )}
        {strValue && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onChange("")}
            className="h-9 shrink-0"
            aria-label={t("sectionsEditor.fileField.removeFileLabel")}
          >
            <Trash01 size={14} />
          </Button>
        )}
      </div>

      <FilePickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        mode="any"
        onSelect={(url) => onChange(url)}
        lockedConfigId={lockedConfig?.id ?? null}
      />
    </div>
  );
}
