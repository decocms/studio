import { Suspense, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { AlertCircle, File02, Image01, Upload01 } from "@untitledui/icons";
import { toast } from "sonner";
import { Button } from "@deco/ui/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import { Skeleton } from "@deco/ui/components/skeleton.tsx";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@deco/ui/components/tabs.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { ErrorBoundary } from "@/web/components/error-boundary";
import {
  type FileConfigInfo,
  useFileConfigs,
} from "@/web/hooks/use-file-configs";
import {
  type PickerObject,
  useFilePickerObjects,
  useFilePickerUpload,
} from "@/web/hooks/use-file-picker";

export type FilePickerMode = "image" | "any";

interface FilePickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: FilePickerMode;
  onSelect: (publicUrl: string) => void;
}

const LAST_CONFIG_KEY = "file-picker:last-config-id";

export function FilePickerDialog(props: FilePickerDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-3xl max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>
            {props.mode === "image" ? "Pick an image" : "Pick a file"}
          </DialogTitle>
          <DialogDescription>
            Upload a new file or pick one previously uploaded to a configured
            bucket.
          </DialogDescription>
        </DialogHeader>
        <ErrorBoundary
          fallback={({ error }) => (
            <PickerError error={error ?? new Error("Failed to load buckets")} />
          )}
        >
          <Suspense fallback={<Skeleton className="h-64 w-full" />}>
            <PickerBody
              mode={props.mode}
              onSelect={(url) => {
                props.onSelect(url);
                props.onOpenChange(false);
              }}
            />
          </Suspense>
        </ErrorBoundary>
      </DialogContent>
    </Dialog>
  );
}

function PickerError({ error }: { error: Error }) {
  return (
    <div className="p-4 rounded-md bg-destructive/10 text-destructive flex items-center gap-2">
      <AlertCircle size={16} />
      <span className="text-sm font-medium">{error.message}</span>
    </div>
  );
}

function PickerBody({
  mode,
  onSelect,
}: {
  mode: FilePickerMode;
  onSelect: (url: string) => void;
}) {
  const configs = useFileConfigs();

  if (configs.length === 0) {
    return <NoConfigsEmpty />;
  }

  if (configs.length === 1) {
    const cfg = configs[0]!;
    return <BucketPanel config={cfg} mode={mode} onSelect={onSelect} />;
  }

  const lastSelected =
    typeof window !== "undefined"
      ? window.localStorage.getItem(LAST_CONFIG_KEY)
      : null;
  const defaultValue =
    configs.find((c) => c.id === lastSelected)?.id ?? configs[0]!.id;

  return (
    <Tabs
      defaultValue={defaultValue}
      onValueChange={(v) => {
        if (typeof window !== "undefined") {
          window.localStorage.setItem(LAST_CONFIG_KEY, v);
        }
      }}
      className="min-h-0 flex-1 flex flex-col"
    >
      <TabsList className="self-start">
        {configs.map((c) => (
          <TabsTrigger key={c.id} value={c.id}>
            {c.name}
          </TabsTrigger>
        ))}
      </TabsList>
      {configs.map((c) => (
        <TabsContent
          key={c.id}
          value={c.id}
          className="min-h-0 flex-1 overflow-hidden"
        >
          <BucketPanel config={c} mode={mode} onSelect={onSelect} />
        </TabsContent>
      ))}
    </Tabs>
  );
}

function NoConfigsEmpty() {
  return (
    <div className="rounded-xl border border-dashed border-border/60 p-10 flex flex-col items-center justify-center text-center gap-3">
      <div className="size-12 rounded-full bg-muted flex items-center justify-center">
        <Upload01 size={20} className="text-muted-foreground" />
      </div>
      <div>
        <p className="font-medium text-sm">No bucket configured</p>
        <p className="text-xs text-muted-foreground mt-1 max-w-sm">
          Add an S3-compatible bucket in Settings before you can upload files.
        </p>
      </div>
      <Button asChild size="sm" className="mt-2">
        <Link to="/settings/files">Configure a bucket</Link>
      </Button>
    </div>
  );
}

function BucketPanel({
  config,
  mode,
  onSelect,
}: {
  config: FileConfigInfo;
  mode: FilePickerMode;
  onSelect: (url: string) => void;
}) {
  const objectsQuery = useFilePickerObjects({ configId: config.id });
  const upload = useFilePickerUpload();
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const accept = mode === "image" ? "image/*" : undefined;

  async function handleFiles(files: FileList | File[] | null) {
    if (!files) return;
    const list = Array.from(files);
    if (list.length === 0) return;
    // For now upload sequentially; first one becomes the selection. Multiple
    // selection is a future iteration.
    try {
      let firstUrl: string | null = null;
      for (const f of list) {
        const result = await upload.mutateAsync({
          configId: config.id,
          file: f,
        });
        firstUrl ??= result.publicUrl;
      }
      await objectsQuery.refetch();
      if (firstUrl) {
        onSelect(firstUrl);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    }
  }

  function onDragOver(e: React.DragEvent) {
    e.preventDefault();
    setIsDragging(true);
  }
  function onDragLeave() {
    setIsDragging(false);
  }
  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setIsDragging(false);
    handleFiles(e.dataTransfer.files);
  }

  const items = (objectsQuery.data?.items ?? []).filter((item) =>
    mode === "image" ? isImageKey(item.key) : true,
  );

  return (
    <div className="flex flex-col gap-3 min-h-0 h-full">
      <button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className={cn(
          "rounded-xl border border-dashed border-border/60 p-6 flex flex-col items-center justify-center gap-2 text-center transition-colors",
          isDragging && "border-primary bg-primary/5",
          upload.isPending && "opacity-60 pointer-events-none",
        )}
      >
        <Upload01 size={18} className="text-muted-foreground" />
        <p className="text-sm font-medium">
          {upload.isPending
            ? "Uploading…"
            : "Drop files here or click to upload"}
        </p>
        <p className="text-xs text-muted-foreground">
          Up to 25 MB.{" "}
          {mode === "image"
            ? "Images only (PNG, JPEG, WebP, GIF, SVG, AVIF)."
            : "Common image, video, audio, and document types."}
        </p>
        <input
          ref={fileInputRef}
          type="file"
          accept={accept}
          multiple
          className="hidden"
          onChange={(e) => handleFiles(e.target.files)}
        />
      </button>

      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          {config.bucket} · {config.region}
          {config.prefix ? ` · ${config.prefix}` : ""}
        </p>
        {objectsQuery.isFetching ? (
          <span className="text-xs text-muted-foreground">Loading…</span>
        ) : null}
      </div>

      <div className="min-h-0 overflow-y-auto pr-1">
        {items.length === 0 ? (
          <p className="text-xs text-muted-foreground py-8 text-center">
            No files yet. Drop something above to upload.
          </p>
        ) : mode === "image" ? (
          <ImageGrid items={items} onSelect={onSelect} />
        ) : (
          <FileList items={items} onSelect={onSelect} />
        )}
      </div>
    </div>
  );
}

function isImageKey(key: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i.test(key);
}

function ImageGrid({
  items,
  onSelect,
}: {
  items: PickerObject[];
  onSelect: (url: string) => void;
}) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          onClick={() => onSelect(item.publicUrl)}
          className="group relative aspect-square rounded-lg overflow-hidden border border-border/60 bg-muted hover:ring-2 hover:ring-primary transition"
          title={item.key}
        >
          <img
            src={item.publicUrl}
            alt={item.key}
            loading="lazy"
            className="w-full h-full object-cover"
            onError={(e) => {
              const img = e.target as HTMLImageElement;
              img.style.display = "none";
            }}
          />
          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent p-2 opacity-0 group-hover:opacity-100 transition">
            <p className="text-xs text-white truncate">{basename(item.key)}</p>
          </div>
        </button>
      ))}
    </div>
  );
}

function FileList({
  items,
  onSelect,
}: {
  items: PickerObject[];
  onSelect: (url: string) => void;
}) {
  return (
    <ul className="divide-y divide-border/60 rounded-lg border border-border/60">
      {items.map((item) => (
        <li key={item.key}>
          <button
            type="button"
            onClick={() => onSelect(item.publicUrl)}
            className="w-full text-left flex items-center gap-3 px-3 py-2 hover:bg-muted/50 transition"
          >
            <div className="size-9 rounded-md bg-muted flex items-center justify-center shrink-0">
              {isImageKey(item.key) ? (
                <Image01 size={16} className="text-muted-foreground" />
              ) : (
                <File02 size={16} className="text-muted-foreground" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium truncate">
                {basename(item.key)}
              </p>
              <p className="text-xs text-muted-foreground truncate font-mono">
                {item.key}
              </p>
            </div>
            <span className="text-xs text-muted-foreground shrink-0">
              {formatSize(item.size)}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function basename(key: string): string {
  const parts = key.split("/");
  return parts[parts.length - 1] ?? key;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
