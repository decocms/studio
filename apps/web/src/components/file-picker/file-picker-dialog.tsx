import { Suspense, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useProjectContext } from "@/sdk";
import {
  AlertCircle,
  Check,
  Copy01,
  DotsVertical,
  File02,
  Image01,
  LinkExternal01,
  Loading01,
  Upload01,
} from "@untitledui/icons";
import { toast } from "sonner";
import { Button } from "@deco/ui/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@deco/ui/components/dropdown-menu.tsx";
import { SearchInput } from "@deco/ui/components/search-input.tsx";
import { Skeleton } from "@deco/ui/components/skeleton.tsx";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@deco/ui/components/tabs.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { ErrorBoundary } from "@/components/error-boundary";
import { useT } from "@/i18n/use-t.ts";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { type FileConfigInfo, useFileConfigs } from "@/hooks/use-file-configs";
import {
  type PickerObject,
  useFilePickerObjects,
  useFilePickerUpload,
} from "@/hooks/use-file-picker";

export type FilePickerMode = "image" | "any";

interface FilePickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: FilePickerMode;
  onSelect: (publicUrl: string) => void;
  lockedConfigId?: string | null;
}

export const LAST_CONFIG_KEY = "file-picker:last-config-id";

export function FilePickerDialog(props: FilePickerDialogProps) {
  const t = useT();
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-3xl max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>
            {props.mode === "image"
              ? t("filePicker.filePickerDialog.pickAnImage")
              : t("filePicker.filePickerDialog.pickAFile")}
          </DialogTitle>
          <DialogDescription>
            {t("filePicker.filePickerDialog.description")}
          </DialogDescription>
        </DialogHeader>
        <ErrorBoundary
          fallback={({ error }) => (
            <PickerError
              error={
                error ??
                new Error(t("filePicker.filePickerDialog.failedToLoadBuckets"))
              }
            />
          )}
        >
          <Suspense fallback={<Skeleton className="h-64 w-full" />}>
            <PickerBody
              mode={props.mode}
              lockedConfigId={props.lockedConfigId}
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
  lockedConfigId,
  onSelect,
}: {
  mode: FilePickerMode;
  lockedConfigId?: string | null;
  onSelect: (url: string) => void;
}) {
  const configs = useFileConfigs();

  if (configs.length === 0) {
    return <NoConfigsEmpty />;
  }

  if (lockedConfigId) {
    const locked = configs.find((config) => config.id === lockedConfigId);
    if (locked) {
      return <BucketPanel config={locked} mode={mode} onSelect={onSelect} />;
    }
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
  const { org } = useProjectContext();
  const t = useT();
  return (
    <div className="rounded-xl border border-dashed border-border/60 p-10 flex flex-col items-center justify-center text-center gap-3">
      <div className="size-12 rounded-full bg-muted flex items-center justify-center">
        <Upload01 size={20} className="text-muted-foreground" />
      </div>
      <div>
        <p className="font-medium text-sm">
          {t("filePicker.filePickerDialog.noBucketConfigured")}
        </p>
        <p className="text-xs text-muted-foreground mt-1 max-w-sm">
          {t("filePicker.filePickerDialog.noBucketDescription")}
        </p>
      </div>
      <Button asChild size="sm" className="mt-2">
        <Link to="/$org/files" params={{ org: org.slug }}>
          {t("filePicker.filePickerDialog.configureABucket")}
        </Link>
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
  const t = useT();
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search, 300);
  const objectsQuery = useFilePickerObjects({
    configId: config.id,
    search: debouncedSearch,
    imageOnly: mode === "image",
  });
  const upload = useFilePickerUpload();
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const accept = mode === "image" ? "image/*" : undefined;

  async function handleFiles(files: FileList | File[] | null) {
    if (!files) return;
    const list = Array.from(files);
    if (list.length === 0) return;

    // Upload each file independently so a single mid-batch failure
    // doesn't discard the work already done — we still refetch the
    // listing and select the first successful upload, then surface
    // the failed names in a toast.
    let firstUrl: string | null = null;
    const failures: string[] = [];
    for (const f of list) {
      try {
        const result = await upload.mutateAsync({
          configId: config.id,
          file: f,
        });
        firstUrl ??= result.publicUrl;
      } catch (err) {
        failures.push(
          `${f.name} (${err instanceof Error ? err.message : "upload failed"})`,
        );
      }
    }
    await objectsQuery.refetch();
    if (failures.length > 0) {
      toast.error(
        failures.length === list.length
          ? t("filePicker.filePickerDialog.uploadFailedAll", {
              errors: failures.join("; "),
            })
          : t("filePicker.filePickerDialog.uploadFailedSome", {
              errors: failures.join("; "),
            }),
      );
    }
    if (firstUrl) {
      onSelect(firstUrl);
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

  const pages = objectsQuery.data?.pages ?? [];
  const allItems = pages.flatMap((p) => p.items);
  const items = allItems.filter((item) =>
    mode === "image" ? isImageKey(item.key) : true,
  );
  const activeSearch = debouncedSearch.trim();
  // The search box stays visible while a search is active even if it returns
  // nothing, so the user can always clear or refine it.
  const showSearch = allItems.length > 0 || search.trim().length > 0;
  const isSearching =
    search !== debouncedSearch ||
    (objectsQuery.isFetching && !objectsQuery.isFetchingNextPage);

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
            ? t("filePicker.filePickerDialog.uploading")
            : t("filePicker.filePickerDialog.dropFilesOrClick")}
        </p>
        <p className="text-xs text-muted-foreground">
          {t("filePicker.filePickerDialog.uploadSizeLimit")}{" "}
          {mode === "image"
            ? t("filePicker.filePickerDialog.imagesOnlyTypes")
            : t("filePicker.filePickerDialog.commonMediaTypes")}
        </p>
        <input
          ref={fileInputRef}
          type="file"
          accept={accept}
          multiple
          className="hidden"
          onChange={(e) => {
            // Copy the File refs out BEFORE resetting: `e.target.files` is a
            // live FileList and `e.target.value = ""` (which lets the user
            // re-pick the same file) empties it, so a bare reference would be
            // length 0 by the time handleFiles runs.
            const files = Array.from(e.target.files ?? []);
            e.target.value = "";
            handleFiles(files);
          }}
        />
      </button>

      {showSearch ? (
        <SearchInput
          value={search}
          onChange={setSearch}
          isSearching={isSearching}
          placeholder={
            mode === "image"
              ? t("filePicker.filePickerDialog.searchImagesPlaceholder")
              : t("filePicker.filePickerDialog.searchFilesPlaceholder")
          }
          className="shrink-0"
        />
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        {items.length === 0 ? (
          activeSearch ? (
            <NoSearchResults query={activeSearch} />
          ) : mode === "image" && allItems.length > 0 ? (
            <NonImagesNotice />
          ) : (
            <EmptyGalleryState />
          )
        ) : mode === "image" ? (
          <ImageGrid items={items} onSelect={onSelect} />
        ) : (
          <FileList items={items} onSelect={onSelect} />
        )}

        {objectsQuery.hasNextPage && (
          <div className="flex justify-center py-4">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={objectsQuery.isFetchingNextPage}
              onClick={() => objectsQuery.fetchNextPage()}
            >
              {objectsQuery.isFetchingNextPage ? (
                <>
                  <Loading01 size={14} className="animate-spin" />
                  {t("filePicker.filePickerDialog.loading")}
                </>
              ) : (
                t("filePicker.filePickerDialog.loadMore")
              )}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function EmptyGalleryState() {
  const t = useT();
  return (
    <div className="flex h-full min-h-40 flex-col items-center justify-center gap-2 py-8 text-center">
      <div className="flex size-10 items-center justify-center rounded-full bg-muted">
        <Image01 size={18} className="text-muted-foreground" />
      </div>
      <p className="text-sm font-medium">
        {t("filePicker.filePickerDialog.noFilesYet")}
      </p>
      <p className="text-xs text-muted-foreground">
        {t("filePicker.filePickerDialog.dropFileToGetStarted")}
      </p>
    </div>
  );
}

function NonImagesNotice() {
  const t = useT();
  return (
    <div className="flex h-full min-h-40 flex-col items-center justify-center gap-2 py-8 text-center">
      <div className="flex size-10 items-center justify-center rounded-full bg-muted">
        <Image01 size={18} className="text-muted-foreground" />
      </div>
      <p className="text-sm font-medium">
        {t("filePicker.filePickerDialog.noImagesYet")}
      </p>
      <p className="text-xs text-muted-foreground">
        {t("filePicker.filePickerDialog.noImagesFormatDesc")}
      </p>
    </div>
  );
}

function NoSearchResults({ query }: { query: string }) {
  const t = useT();
  return (
    <div className="flex h-full min-h-40 flex-col items-center justify-center gap-2 py-8 text-center">
      <div className="flex size-10 items-center justify-center rounded-full bg-muted">
        <Image01 size={18} className="text-muted-foreground" />
      </div>
      <p className="text-sm font-medium">
        {t("filePicker.filePickerDialog.noMatches", { query })}
      </p>
      <p className="text-xs text-muted-foreground">
        {t("filePicker.filePickerDialog.tryDifferentSearchOrLoadMore")}
      </p>
    </div>
  );
}

function isImageKey(key: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i.test(key);
}

function extensionTag(key: string): string {
  const dot = key.lastIndexOf(".");
  if (dot < 0 || dot === key.length - 1) return "file";
  return key.slice(dot + 1).toLowerCase();
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
        <AssetCard
          key={item.key}
          item={item}
          variant="image"
          onSelect={onSelect}
        />
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
          <AssetCard item={item} variant="row" onSelect={onSelect} />
        </li>
      ))}
    </ul>
  );
}

function AssetCard({
  item,
  variant,
  onSelect,
}: {
  item: PickerObject;
  variant: "image" | "row";
  onSelect: (url: string) => void;
}) {
  const ext = extensionTag(item.key);
  if (variant === "image") {
    return (
      <div className="group relative aspect-square overflow-hidden rounded-lg border border-border/60 bg-muted">
        <button
          type="button"
          onClick={() => onSelect(item.publicUrl)}
          className="block h-full w-full transition hover:ring-2 hover:ring-primary"
          title={item.key}
        >
          <img
            src={item.publicUrl}
            alt={item.key}
            loading="lazy"
            className="h-full w-full object-cover"
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = "none";
            }}
          />
        </button>
        <span className="pointer-events-none absolute left-1.5 top-1.5 rounded bg-background/80 px-1.5 py-0.5 text-[10px] font-medium uppercase text-foreground opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100">
          {ext}
        </span>
        <div className="absolute right-1.5 top-1.5 opacity-0 transition-opacity group-hover:opacity-100">
          <AssetCardMenu item={item} onSelect={onSelect} />
        </div>
        <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent p-2 opacity-0 transition-opacity group-hover:opacity-100">
          <p className="truncate text-xs text-white">{basename(item.key)}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="group flex items-center gap-3 px-3 py-2 transition hover:bg-muted/50">
      <button
        type="button"
        onClick={() => onSelect(item.publicUrl)}
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
      >
        <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted">
          {isImageKey(item.key) ? (
            <Image01 size={16} className="text-muted-foreground" />
          ) : (
            <File02 size={16} className="text-muted-foreground" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{basename(item.key)}</p>
          <p className="truncate font-mono text-xs text-muted-foreground">
            {item.key}
          </p>
        </div>
        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase text-muted-foreground">
          {ext}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {formatSize(item.size)}
        </span>
      </button>
      <AssetCardMenu item={item} onSelect={onSelect} />
    </div>
  );
}

function AssetCardMenu({
  item,
  onSelect,
}: {
  item: PickerObject;
  onSelect: (url: string) => void;
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);

  async function copyUrl(e: React.MouseEvent | Event) {
    e.preventDefault();
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(item.publicUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error(t("filePicker.filePickerDialog.failedToCopyUrl"));
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 rounded-md bg-background/80 backdrop-blur-sm"
          onClick={(e) => e.stopPropagation()}
          aria-label={t("filePicker.filePickerDialog.assetActions")}
        >
          <DotsVertical size={14} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
        <DropdownMenuItem onClick={() => onSelect(item.publicUrl)}>
          <Check size={14} />
          {t("filePicker.filePickerDialog.useThis")}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={copyUrl}>
          {copied ? <Check size={14} /> : <Copy01 size={14} />}
          {copied
            ? t("filePicker.filePickerDialog.copied")
            : t("filePicker.filePickerDialog.copyUrl")}
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <a
            href={item.publicUrl}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
          >
            <LinkExternal01 size={14} />
            {t("filePicker.filePickerDialog.openInNewTab")}
          </a>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
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
