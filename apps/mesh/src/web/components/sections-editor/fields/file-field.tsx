import { useState } from "react";
import { File02, Film01, Trash01, Upload01 } from "@untitledui/icons";
import { toast } from "sonner";
import { Button } from "@deco/ui/components/button.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import { Label } from "@deco/ui/components/label.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  FilePickerDialog,
  LAST_CONFIG_KEY,
} from "@/web/components/file-picker/file-picker-dialog";
import { useFileConfigsQuery } from "@/web/hooks/use-file-configs";
import { useFilePickerUpload } from "@/web/hooks/use-file-picker";
import { extractUrl } from "./extract-url";
import type { FieldProps } from "./field-props";

function ExtBadge({ ext }: { ext: string }) {
  if (!ext) return null;
  return (
    <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase text-muted-foreground">
      {ext}
    </span>
  );
}

function basename(url: string): string {
  try {
    const path = new URL(url).pathname;
    return decodeURIComponent(path.split("/").pop() ?? url);
  } catch {
    return url.split("/").pop() ?? url;
  }
}

function extension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot < 0 || dot === filename.length - 1) return "";
  return filename.slice(dot + 1).toLowerCase();
}

export function FileField({
  schema,
  value,
  onChange,
  path,
  label,
}: FieldProps) {
  const isVideo = schema.format === "video-uri";
  const strValue = extractUrl(value);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const fileName = strValue ? basename(strValue) : "";
  const ext = fileName ? extension(fileName) : "";

  const configsQuery = useFileConfigsQuery();
  const upload = useFilePickerUpload();

  function resolveTargetConfigId(): string | null {
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
    const list = Array.from(files);
    if (list.length === 0) return;

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
          `Uploaded ${list[0]!.name}; extra files were ignored (single-select field).`,
        );
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
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
    // bulletproofs against any broken min-w-0 chain above.
    <div className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)] gap-2 overflow-hidden">
      <div className="min-w-0 space-y-0.5">
        <Label htmlFor={path} className="text-muted-foreground">
          {label}
        </Label>
        {schema.description && (
          <p className="text-xs leading-normal text-muted-foreground">
            {schema.description}
          </p>
        )}
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
              <div className="relative h-40 w-full overflow-hidden bg-black">
                <video
                  key={strValue}
                  src={strValue}
                  preload="metadata"
                  className="h-full w-full object-contain"
                />
              </div>
              <div className="flex items-center gap-2 border-t border-border/60 bg-background/50 px-3 py-2">
                <Film01 size={14} className="shrink-0 text-muted-foreground" />
                <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                  {fileName}
                </p>
                <ExtBadge ext={ext} />
              </div>
            </>
          ) : (
            <div className="flex items-center gap-3 px-3 py-2.5">
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
            </div>
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
                ? "Uploading…"
                : isVideo
                  ? "Drop a video here or click to browse"
                  : "Drop a file or click to browse"}
            </span>
            <span className="text-xs text-muted-foreground">Up to 100 MB</span>
          </button>
        )}

        {isDragging && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-primary/10 backdrop-blur-[1px]">
            <span className="rounded-md bg-background px-3 py-1.5 text-xs font-medium shadow">
              Drop to upload
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
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setPickerOpen(true)}
          className="h-9 shrink-0"
        >
          <Upload01 size={14} />
          {strValue ? "Replace" : "Browse"}
        </Button>
        {strValue && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onChange("")}
            className="h-9 shrink-0"
            aria-label="Remove file"
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
      />
    </div>
  );
}
