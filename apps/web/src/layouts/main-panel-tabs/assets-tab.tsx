/**
 * Assets tab — a native, per-site browser over the S3 bucket associated with
 * this site's `metadata.siteSlug` (matched via `matchSiteSlugConfig`). Replaces
 * the deco.cx admin-MCP `fetch_assets` iframe view: it lists, uploads, and
 * deletes objects directly against the configured bucket using the same
 * FILE_* tools the CMS file picker uses. The tab only appears when a bucket is
 * associated to the site (see use-main-panel-tabs), so a missing config here is
 * a rare race — handled with an empty state rather than an error.
 */

import { useRef, useState } from "react";
import {
  Check,
  Copy01,
  DotsVertical,
  File02,
  Image01,
  LinkExternal01,
  Loading01,
  Package,
  Trash01,
  Upload01,
} from "@untitledui/icons";
import { toast } from "sonner";
import { Button, buttonVariants } from "@decocms/ui/components/button.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@decocms/ui/components/alert-dialog.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@decocms/ui/components/dropdown-menu.tsx";
import { SearchInput } from "@decocms/ui/components/search-input.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useVirtualMCP } from "@/sdk";
import { useT } from "@/i18n/use-t.ts";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { type FileConfigInfo, useFileConfigs } from "@/hooks/use-file-configs";
import {
  type PickerObject,
  useFilePickerDelete,
  useFilePickerObjects,
  useFilePickerUpload,
} from "@/hooks/use-file-picker";
import { matchSiteSlugConfig } from "@/components/file-picker/match-site-slug-config";
import {
  basename,
  extensionTag,
  formatSize,
  isImageKey,
} from "@/components/file-picker/asset-utils";

export function AssetsTab({ virtualMcpId }: { virtualMcpId: string }) {
  const entity = useVirtualMCP(virtualMcpId);
  const configs = useFileConfigs();
  const siteSlug =
    (entity?.metadata as { siteSlug?: string | null } | undefined)?.siteSlug ??
    null;
  const config = matchSiteSlugConfig(configs, siteSlug);

  if (!config) {
    return <NoBucketState />;
  }

  return <AssetsBrowser config={config} />;
}

function NoBucketState() {
  const t = useT();
  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3 p-10 text-center">
      <div className="flex size-12 items-center justify-center rounded-full bg-muted">
        <Package size={20} className="text-muted-foreground" />
      </div>
      <div>
        <p className="text-sm font-medium">
          {t("assets.browser.noBucketTitle")}
        </p>
        <p className="mt-1 max-w-sm text-xs text-muted-foreground">
          {t("assets.browser.noBucketDescription")}
        </p>
      </div>
    </div>
  );
}

function AssetsBrowser({ config }: { config: FileConfigInfo }) {
  const t = useT();
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search, 300);
  const objectsQuery = useFilePickerObjects({
    configId: config.id,
    search: debouncedSearch,
  });
  const upload = useFilePickerUpload();
  const [isDragging, setIsDragging] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<PickerObject | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  async function handleFiles(files: FileList | File[] | null) {
    if (!files) return;
    const list = Array.from(files);
    if (list.length === 0) return;

    // Upload each file independently so one failure doesn't discard the rest.
    const failures: string[] = [];
    for (const f of list) {
      try {
        await upload.mutateAsync({ configId: config.id, file: f });
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
    // Don't let the drop bubble to the chat composer's window-level listener.
    e.stopPropagation();
    setIsDragging(false);
    handleFiles(e.dataTransfer.files);
  }

  const pages = objectsQuery.data?.pages ?? [];
  const items = pages.flatMap((p) => p.items);
  const activeSearch = debouncedSearch.trim();
  const isSearching =
    search !== debouncedSearch ||
    (objectsQuery.isFetching && !objectsQuery.isFetchingNextPage);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-4">
      <div className="flex shrink-0 items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">{t("assets.browser.title")}</h2>
          <p className="truncate text-xs text-muted-foreground">
            {t("assets.browser.bucketLabel", { name: config.name })}
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          disabled={upload.isPending}
          onClick={() => fileInputRef.current?.click()}
        >
          {upload.isPending ? (
            <Loading01 size={14} className="animate-spin" />
          ) : (
            <Upload01 size={14} />
          )}
          {upload.isPending
            ? t("filePicker.filePickerDialog.uploading")
            : t("filePicker.filePickerDialog.dropFilesOrClick")}
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            // Copy refs out before reset: e.target.files is live and clears.
            const files = Array.from(e.target.files ?? []);
            e.target.value = "";
            handleFiles(files);
          }}
        />
      </div>

      <SearchInput
        value={search}
        onChange={setSearch}
        isSearching={isSearching}
        placeholder={t("filePicker.filePickerDialog.searchFilesPlaceholder")}
        className="shrink-0"
      />

      <button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className={cn(
          "flex shrink-0 flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-border/60 p-4 text-center transition-colors",
          isDragging && "border-primary bg-primary/5",
          upload.isPending && "pointer-events-none opacity-60",
        )}
      >
        <Upload01 size={16} className="text-muted-foreground" />
        <p className="text-xs text-muted-foreground">
          {t("filePicker.filePickerDialog.dropFilesOrClick")}{" "}
          {t("filePicker.filePickerDialog.uploadSizeLimit")}
        </p>
      </button>

      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        {items.length === 0 ? (
          activeSearch ? (
            <EmptyNote
              title={t("filePicker.filePickerDialog.noMatches", {
                query: activeSearch,
              })}
              description={t(
                "filePicker.filePickerDialog.tryDifferentSearchOrLoadMore",
              )}
            />
          ) : (
            <EmptyNote
              title={t("filePicker.filePickerDialog.noFilesYet")}
              description={t(
                "filePicker.filePickerDialog.dropFileToGetStarted",
              )}
            />
          )
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
            {items.map((item) => (
              <AssetCard
                key={item.key}
                item={item}
                onDelete={() => setPendingDelete(item)}
              />
            ))}
          </div>
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

      <DeleteAssetDialog
        configId={config.id}
        item={pendingDelete}
        onClose={() => setPendingDelete(null)}
      />
    </div>
  );
}

function EmptyNote({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="flex h-full min-h-40 flex-col items-center justify-center gap-2 py-8 text-center">
      <div className="flex size-10 items-center justify-center rounded-full bg-muted">
        <Image01 size={18} className="text-muted-foreground" />
      </div>
      <p className="text-sm font-medium">{title}</p>
      <p className="text-xs text-muted-foreground">{description}</p>
    </div>
  );
}

function AssetCard({
  item,
  onDelete,
}: {
  item: PickerObject;
  onDelete: () => void;
}) {
  const ext = extensionTag(item.key);
  const isImage = isImageKey(item.key);
  return (
    <div className="group relative flex flex-col overflow-hidden rounded-lg border border-border/60 bg-muted">
      <a
        href={item.publicUrl}
        target="_blank"
        rel="noreferrer"
        title={item.key}
        className="flex aspect-square items-center justify-center transition hover:ring-2 hover:ring-primary"
      >
        {isImage ? (
          <img
            src={item.publicUrl}
            alt={item.key}
            loading="lazy"
            className="h-full w-full object-cover"
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = "none";
            }}
          />
        ) : (
          <File02 size={28} className="text-muted-foreground" />
        )}
      </a>
      <div className="flex items-center gap-1 border-t border-border/60 bg-background px-2 py-1.5">
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium" title={item.key}>
            {basename(item.key)}
          </p>
          <p className="text-[10px] uppercase text-muted-foreground">
            {ext} · {formatSize(item.size)}
          </p>
        </div>
        <AssetCardMenu item={item} onDelete={onDelete} />
      </div>
    </div>
  );
}

function AssetCardMenu({
  item,
  onDelete,
}: {
  item: PickerObject;
  onDelete: () => void;
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);

  async function copyUrl() {
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
          className="size-7 shrink-0 rounded-md"
          aria-label={t("filePicker.filePickerDialog.assetActions")}
        >
          <DotsVertical size={14} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={copyUrl}>
          {copied ? <Check size={14} /> : <Copy01 size={14} />}
          {copied
            ? t("filePicker.filePickerDialog.copied")
            : t("filePicker.filePickerDialog.copyUrl")}
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <a href={item.publicUrl} target="_blank" rel="noreferrer">
            <LinkExternal01 size={14} />
            {t("filePicker.filePickerDialog.openInNewTab")}
          </a>
        </DropdownMenuItem>
        <DropdownMenuItem variant="destructive" onClick={onDelete}>
          <Trash01 size={14} />
          {t("assets.browser.deleteAction")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function DeleteAssetDialog({
  configId,
  item,
  onClose,
}: {
  configId: string;
  item: PickerObject | null;
  onClose: () => void;
}) {
  const t = useT();
  const del = useFilePickerDelete();

  async function confirmDelete() {
    if (!item) return;
    try {
      await del.mutateAsync({ configId, key: item.key });
      toast.success(t("assets.browser.deleted"));
      onClose();
    } catch {
      toast.error(t("assets.browser.deleteFailed"));
    }
  }

  return (
    <AlertDialog open={!!item} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t("assets.browser.deleteConfirmTitle")}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t("assets.browser.deleteConfirmDescription", {
              name: item ? basename(item.key) : "",
            })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={del.isPending}>
            {t("assets.browser.deleteCancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            className={cn(buttonVariants({ variant: "destructive" }))}
            disabled={del.isPending}
            onClick={(e) => {
              e.preventDefault();
              confirmDelete();
            }}
          >
            {del.isPending ? (
              <Loading01 size={14} className="animate-spin" />
            ) : null}
            {t("assets.browser.deleteConfirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
