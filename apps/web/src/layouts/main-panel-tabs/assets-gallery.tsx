/**
 * Assets gallery for Blocks v8 projects: a masonry of the project's bucket
 * with kind filters, a details panel, and in-place replace. Other projects
 * keep the browser in `assets-tab.tsx`, which also picks the bucket.
 */

import { useRef, useState } from "react";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import {
  AlertTriangle,
  Check,
  ChevronRight,
  Copy01,
  File02,
  Image01,
  LinkExternal01,
  Play,
  Plus,
  RefreshCcw01,
  Trash01,
  Upload01,
  XClose,
} from "@untitledui/icons";
import { toast } from "sonner";
import { Button } from "@decocms/ui/components/button.tsx";
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
import { Input } from "@decocms/ui/components/input.tsx";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@decocms/ui/components/sheet.tsx";
import { SearchInput } from "@decocms/ui/components/search-input.tsx";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@decocms/ui/components/toggle-group.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useT } from "@/i18n/use-t.ts";
import { LOCALE_TAG } from "@/i18n/locale.ts";
import { usePreferences } from "@/hooks/use-preferences.ts";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useElementWidth } from "@/hooks/use-element-width";
import type { FileConfigInfo } from "@/hooks/use-file-configs";
import {
  type PickerObject,
  useFilePickerDelete,
  useFilePickerObjects,
  useFilePickerUpload,
} from "@/hooks/use-file-picker";
import {
  type AssetKind,
  type Dimensions,
  aspectRatioDiffers,
  assetKind,
  displayName,
  extensionTag,
  formatSize,
  previewUrl,
  sameFormat,
} from "@/components/file-picker/asset-utils";
import { assetColumnCount, distributeIntoColumns } from "./asset-columns";

type KindFilter = "all" | AssetKind;

export function AssetsGallery({ config }: { config: FileConfigInfo }) {
  const t = useT();
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search, 300);
  const objectsQuery = useFilePickerObjects({
    configId: config.id,
    search: debouncedSearch,
  });
  const upload = useFilePickerUpload();
  const [kind, setKind] = useState<KindFilter>("all");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<PickerObject | null>(null);
  const [replacing, setReplacing] = useState<PickerObject | null>(null);
  const [panel, setPanel] = useState<HTMLDivElement | null>(null);
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
  function onDragLeave(e: React.DragEvent) {
    // Ignore dragleave fired while moving between the gallery's own children.
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setIsDragging(false);
  }
  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    // Don't let the drop bubble to the chat composer's window-level listener.
    e.stopPropagation();
    setIsDragging(false);
    handleFiles(e.dataTransfer.files);
  }

  const [gridWidth, gridRef] = useElementWidth();
  const pages = objectsQuery.data?.pages ?? [];
  const items = pages.flatMap((p) => p.items);
  const visible =
    kind === "all" ? items : items.filter((i) => assetKind(i.key) === kind);
  const columns = distributeIntoColumns(visible, assetColumnCount(gridWidth));
  const selected = visible.find((i) => i.key === selectedKey) ?? null;
  const activeSearch = debouncedSearch.trim();
  const isSearching =
    search !== debouncedSearch ||
    (objectsQuery.isFetching && !objectsQuery.isFetchingNextPage);

  return (
    <div
      ref={setPanel}
      className="relative flex h-full min-h-0 overflow-hidden"
    >
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 flex-wrap items-center gap-3 px-4 pb-3 pt-4">
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold">
              {t("assets.browser.title")}
            </h2>
            <p className="truncate text-xs text-muted-foreground">
              {t("assets.browser.bucketLabel", { name: config.name })}
            </p>
          </div>
          <ToggleGroup
            type="single"
            variant="segmented"
            size="sm"
            value={kind}
            aria-label={t("assets.browser.filterLabel")}
            onValueChange={(next) => {
              if (
                next === "all" ||
                next === "image" ||
                next === "video" ||
                next === "document"
              ) {
                setKind(next);
              }
            }}
          >
            <ToggleGroupItem value="all">
              {t("assets.browser.filterAll")}
            </ToggleGroupItem>
            <ToggleGroupItem value="image">
              {t("assets.browser.filterImages")}
            </ToggleGroupItem>
            <ToggleGroupItem value="video">
              {t("assets.browser.filterVideos")}
            </ToggleGroupItem>
            <ToggleGroupItem value="document">
              {t("assets.browser.filterDocuments")}
            </ToggleGroupItem>
          </ToggleGroup>
          <SearchInput
            value={search}
            onChange={setSearch}
            isSearching={isSearching}
            placeholder={t(
              "filePicker.filePickerDialog.searchFilesPlaceholder",
            )}
            className="w-56 shrink-0"
          />
        </div>

        <div
          className="relative min-h-0 flex-1"
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
        >
          <div className="absolute inset-0 overflow-y-auto px-4 pb-24">
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
            ) : visible.length === 0 ? (
              <EmptyNote
                title={t("assets.browser.emptyFilterTitle")}
                description={t("assets.browser.emptyFilterDescription")}
              />
            ) : (
              <div ref={gridRef} className="flex items-start gap-2.5">
                {columns.map((column, columnIndex) => (
                  <div
                    // Column buckets are positional, so the index is the identity.
                    key={columnIndex}
                    className="flex min-w-0 flex-1 flex-col gap-2.5"
                  >
                    {column.map((item) => (
                      <AssetTile
                        key={item.key}
                        item={item}
                        selected={item.key === selectedKey}
                        onSelect={() =>
                          setSelectedKey(
                            item.key === selectedKey ? null : item.key,
                          )
                        }
                      />
                    ))}
                  </div>
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
                      <Spinner className="size-3.5" />
                      {t("filePicker.filePickerDialog.loading")}
                    </>
                  ) : (
                    t("filePicker.filePickerDialog.loadMore")
                  )}
                </Button>
              </div>
            )}
          </div>

          {isDragging && (
            <div className="pointer-events-none absolute inset-2 flex items-center justify-center rounded-xl border-2 border-dashed border-primary bg-primary/5 text-sm font-medium text-primary">
              {t("assets.browser.dropToUpload")}
            </div>
          )}

          <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center px-4">
            <div className="pointer-events-auto flex w-full max-w-xl items-center gap-2 rounded-full bg-white/45 p-1.5 shadow-[inset_0_1px_0_rgb(255_255_255/0.6),inset_0_0_0_1px_rgb(255_255_255/0.3),0_12px_40px_rgb(0_0_0/0.18)] backdrop-blur-2xl backdrop-saturate-180 dark:bg-white/12 dark:shadow-[inset_0_1px_0_rgb(255_255_255/0.25),inset_0_0_0_1px_rgb(255_255_255/0.12),0_12px_40px_rgb(0_0_0/0.4)]">
              <button
                type="button"
                disabled={upload.isPending}
                onClick={() => fileInputRef.current?.click()}
                className="flex min-w-0 flex-1 items-center gap-2.5 rounded-full text-left text-sm text-foreground/75 disabled:opacity-60 dark:text-foreground dark:[text-shadow:0_1px_3px_rgb(0_0_0/0.5)]"
              >
                <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-white/70 text-foreground dark:bg-black/25">
                  <Plus size={16} />
                </span>
                <span className="truncate">
                  {t("assets.browser.uploadBarHint")}
                  <span className="text-foreground/50 dark:text-foreground/70">
                    {" · "}
                    {t("filePicker.filePickerDialog.uploadSizeLimit")}
                  </span>
                </span>
              </button>
              <Button
                type="button"
                size="sm"
                disabled={upload.isPending}
                onClick={() => fileInputRef.current?.click()}
              >
                {upload.isPending ? (
                  <Spinner className="size-3.5" />
                ) : (
                  <Upload01 size={14} />
                )}
                {upload.isPending
                  ? t("filePicker.filePickerDialog.uploading")
                  : t("assets.browser.upload")}
              </Button>
            </div>
          </div>
        </div>

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

      {selected && (
        <AssetDetails
          key={selected.key}
          item={selected}
          onClose={() => setSelectedKey(null)}
          onReplace={() => setReplacing(selected)}
          onDelete={() => setPendingDelete(selected)}
        />
      )}

      {replacing && (
        <ReplaceAssetSheet
          key={replacing.key}
          configId={config.id}
          item={replacing}
          container={panel}
          onClose={() => setReplacing(null)}
          onReplaced={() => objectsQuery.refetch()}
        />
      )}

      <DeleteAssetDialog
        configId={config.id}
        item={pendingDelete}
        onClose={() => setPendingDelete(null)}
        onDeleted={(key) => {
          if (key === selectedKey) setSelectedKey(null);
        }}
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

/** What a file looks like in the gallery and in its details. */
function AssetPreview({
  item,
  controls,
  onDimensions,
}: {
  item: PickerObject;
  controls?: boolean;
  onDimensions?: (width: number, height: number) => void;
}) {
  const kind = assetKind(item.key);
  if (kind === "image") {
    return (
      <img
        src={previewUrl(item.publicUrl, item.lastModified)}
        alt={displayName(item.key)}
        loading="lazy"
        className="block h-auto w-full"
        onLoad={(e) =>
          onDimensions?.(
            e.currentTarget.naturalWidth,
            e.currentTarget.naturalHeight,
          )
        }
        onError={(e) => {
          e.currentTarget.style.display = "none";
        }}
      />
    );
  }
  if (kind === "video") {
    return (
      <video
        // `#t=0.1` makes browsers that skip the poster frame paint one.
        src={`${previewUrl(item.publicUrl, item.lastModified)}#t=0.1`}
        preload="metadata"
        muted
        playsInline
        controls={controls}
        className="block h-auto w-full"
        onLoadedMetadata={(e) =>
          onDimensions?.(
            e.currentTarget.videoWidth,
            e.currentTarget.videoHeight,
          )
        }
      />
    );
  }
  return (
    <div className="flex aspect-[4/3] items-center justify-center">
      <File02 size={32} className="text-muted-foreground" />
    </div>
  );
}

function AssetTile({
  item,
  selected,
  onSelect,
}: {
  item: PickerObject;
  selected: boolean;
  onSelect: () => void;
}) {
  const t = useT();
  const name = displayName(item.key);
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      aria-label={t("assets.browser.selectAsset", { name })}
      title={name}
      className={cn(
        "group relative block w-full overflow-hidden rounded-xl bg-muted text-left outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring",
        selected
          ? "ring-2 ring-foreground"
          : "shadow-edge hover:ring-2 hover:ring-border",
      )}
    >
      <AssetPreview item={item} />
      {assetKind(item.key) === "video" && (
        <span className="absolute left-2 top-2 flex size-7 items-center justify-center rounded-full bg-black/45 text-white">
          <Play size={12} />
        </span>
      )}
      <span className="absolute inset-x-0 bottom-0 flex items-end gap-2 bg-gradient-to-t from-black/60 to-transparent px-2.5 pb-2 pt-8 text-xs text-white">
        <span className="min-w-0 flex-1 truncate font-medium">{name}</span>
        <span className="shrink-0 opacity-80">{formatSize(item.size)}</span>
      </span>
    </button>
  );
}

function AssetDetails({
  item,
  onClose,
  onReplace,
  onDelete,
}: {
  item: PickerObject;
  onClose: () => void;
  onReplace: () => void;
  onDelete: () => void;
}) {
  const t = useT();
  const [preferences] = usePreferences();
  const [dimensions, setDimensions] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const name = displayName(item.key);
  const uploaded = item.lastModified
    ? new Intl.DateTimeFormat(LOCALE_TAG[preferences.language], {
        dateStyle: "medium",
      }).format(new Date(item.lastModified))
    : null;

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
    <aside className="flex w-80 shrink-0 flex-col gap-4 overflow-y-auto border-l border-border/60 p-4">
      <div className="flex items-center gap-2">
        <p
          className="min-w-0 flex-1 truncate text-sm font-semibold"
          title={name}
        >
          {name}
        </p>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t("assets.details.close")}
          onClick={onClose}
        >
          <XClose size={16} />
        </Button>
      </div>

      <div className="overflow-hidden rounded-xl bg-muted shadow-edge">
        <AssetPreview
          item={item}
          controls
          onDimensions={(width, height) =>
            setDimensions(`${width} × ${height}`)
          }
        />
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
        <Fact label={t("assets.details.type")}>
          {extensionTag(item.key).toUpperCase()}
        </Fact>
        <Fact label={t("assets.details.size")}>{formatSize(item.size)}</Fact>
        {dimensions && (
          <Fact label={t("assets.details.dimensions")}>{dimensions}</Fact>
        )}
        {uploaded && (
          <Fact label={t("assets.details.uploaded")}>{uploaded}</Fact>
        )}
      </dl>

      <div className="flex flex-col gap-1.5">
        <p className="text-xs text-muted-foreground">
          {t("assets.details.url")}
        </p>
        <div className="flex items-center gap-2">
          <Input
            readOnly
            value={item.publicUrl}
            aria-label={t("assets.details.url")}
            className="min-w-0 flex-1 font-mono text-xs"
            onFocus={(e) => e.currentTarget.select()}
          />
          <Button type="button" variant="outline" size="sm" onClick={copyUrl}>
            {copied ? <Check size={14} /> : <Copy01 size={14} />}
            {copied ? t("assets.details.copied") : t("assets.details.copy")}
          </Button>
        </div>
      </div>

      <div className="mt-auto flex items-center gap-2 pt-2">
        <Button type="button" variant="outline" size="sm" onClick={onReplace}>
          <RefreshCcw01 size={14} />
          {t("assets.details.replace")}
        </Button>
        <Button type="button" variant="outline" size="sm" asChild>
          <a href={item.publicUrl} target="_blank" rel="noreferrer">
            <LinkExternal01 size={14} />
            {t("assets.details.open")}
          </a>
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="ml-auto text-destructive hover:text-destructive"
          onClick={onDelete}
        >
          <Trash01 size={14} />
          {t("assets.browser.deleteAction")}
        </Button>
      </div>
    </aside>
  );
}

function Fact({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="truncate">{children}</dd>
    </div>
  );
}

/** The file input filter that keeps a replacement in the same format. */
function acceptFor(key: string): string | undefined {
  const ext = extensionTag(key);
  if (ext === "file") return undefined;
  return ext === "jpg" || ext === "jpeg" ? ".jpg,.jpeg" : `.${ext}`;
}

function formatDimensions(dimensions: Dimensions | null): string | null {
  return dimensions ? `${dimensions.width} × ${dimensions.height}` : null;
}

/**
 * One side of the replace comparison: the whole file, never cropped, over a
 * blurred copy that fills the rest of the fixed frame.
 */
function ComparePreview({
  src,
  kind,
  alt,
  onDimensions,
}: {
  src: string;
  kind: AssetKind;
  alt: string;
  onDimensions: (dimensions: Dimensions) => void;
}) {
  if (kind === "image") {
    return (
      <>
        <img
          src={src}
          alt=""
          aria-hidden
          className="absolute inset-0 size-full scale-110 object-cover opacity-50 blur-2xl"
        />
        <img
          src={src}
          alt={alt}
          className="relative max-h-full max-w-full object-contain"
          onLoad={(e) =>
            onDimensions({
              width: e.currentTarget.naturalWidth,
              height: e.currentTarget.naturalHeight,
            })
          }
        />
      </>
    );
  }
  if (kind === "video") {
    return (
      <video
        src={`${src}#t=0.1`}
        preload="metadata"
        muted
        playsInline
        controls
        className="relative max-h-full max-w-full object-contain"
        onLoadedMetadata={(e) =>
          onDimensions({
            width: e.currentTarget.videoWidth,
            height: e.currentTarget.videoHeight,
          })
        }
      />
    );
  }
  return <File02 size={32} className="text-muted-foreground" />;
}

function ReplaceAssetSheet({
  configId,
  item,
  container,
  onClose,
  onReplaced,
}: {
  configId: string;
  item: PickerObject;
  container: HTMLElement | null;
  onClose: () => void;
  onReplaced: () => void;
}) {
  const t = useT();
  const upload = useFilePickerUpload();
  const [file, setFile] = useState<File | null>(null);
  const [fileUrl, setFileUrl] = useState<string | null>(null);
  const [before, setBefore] = useState<Dimensions | null>(null);
  const [after, setAfter] = useState<Dimensions | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const name = displayName(item.key);
  const format = extensionTag(item.key).toUpperCase();
  const formatOk = !file || sameFormat(item.key, file.name);
  const ratioChanged =
    formatOk && !!before && !!after && aspectRatioDiffers(after, before);

  function choose(next: File | undefined) {
    if (!next) return;
    if (fileUrl) URL.revokeObjectURL(fileUrl);
    setFile(next);
    setFileUrl(URL.createObjectURL(next));
    setAfter(null);
  }

  function close() {
    if (upload.isPending) return;
    if (fileUrl) URL.revokeObjectURL(fileUrl);
    onClose();
  }

  async function confirm() {
    if (!file || !formatOk) return;
    try {
      await upload.mutateAsync({ configId, file, replaceKey: item.key });
      toast.success(t("assets.replace.done"));
      onReplaced();
      close();
    } catch (err) {
      toast.error(
        t("assets.replace.failed", {
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  return (
    <Sheet open onOpenChange={(open) => !open && close()}>
      <SheetContent
        side="bottom"
        container={container}
        className="gap-0 rounded-t-2xl border-0"
      >
        <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-border" />
        <SheetHeader className="mx-auto w-full max-w-4xl px-6 pb-2 pt-3">
          <SheetTitle>{t("assets.replace.title", { name })}</SheetTitle>
          <SheetDescription>{t("assets.replace.description")}</SheetDescription>
        </SheetHeader>

        <div className="mx-auto grid w-full max-w-4xl grid-cols-[1fr_auto_1fr] items-start gap-4 px-6 py-4">
          <div className="flex min-w-0 flex-col gap-2">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t("assets.replace.before")}
            </p>
            <div className="relative flex h-56 items-center justify-center overflow-hidden rounded-xl bg-muted shadow-edge">
              <ComparePreview
                src={previewUrl(item.publicUrl, item.lastModified)}
                kind={assetKind(item.key)}
                alt={name}
                onDimensions={setBefore}
              />
            </div>
            <div className="min-w-0 text-xs">
              <p className="truncate font-medium">{name}</p>
              <p className="text-muted-foreground">
                {[formatSize(item.size), formatDimensions(before)]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </div>
          </div>

          <ChevronRight
            size={18}
            className="mt-32 text-muted-foreground"
            aria-hidden
          />

          <div className="flex min-w-0 flex-col gap-2">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t("assets.replace.after")}
            </p>
            <div
              className={cn(
                "relative flex h-56 items-center justify-center overflow-hidden rounded-xl",
                file ? "shadow-edge" : "bg-muted",
                isDragging && "bg-primary/5 ring-2 ring-primary",
              )}
              onDragOver={(e) => {
                e.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setIsDragging(false);
                choose(e.dataTransfer.files[0]);
              }}
            >
              {file && fileUrl ? (
                <>
                  <ComparePreview
                    src={fileUrl}
                    kind={assetKind(file.name)}
                    alt={file.name}
                    onDimensions={setAfter}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="absolute bottom-2 right-2"
                    disabled={upload.isPending}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    {t("assets.replace.chooseAnother")}
                  </Button>
                </>
              ) : (
                <div className="flex flex-col items-center gap-3 text-center text-sm text-muted-foreground">
                  <Upload01 size={20} />
                  {t("assets.replace.dropHint")}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    {t("assets.replace.choose")}
                  </Button>
                </div>
              )}
            </div>
            <div className="min-w-0 text-xs">
              {file ? (
                <>
                  <p className="truncate font-medium">{file.name}</p>
                  <p className="text-muted-foreground">
                    {[formatSize(file.size), formatDimensions(after)]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </>
              ) : (
                <>
                  <p className="font-medium text-muted-foreground">
                    {t("assets.replace.noFile")}
                  </p>
                  <p className="text-muted-foreground">
                    {t("assets.replace.sameFormatHint", { format })}
                  </p>
                </>
              )}
              {!formatOk && (
                <p className="mt-1 flex items-center gap-1 text-destructive">
                  <AlertTriangle size={12} className="shrink-0" />
                  {t("assets.replace.wrongFormat", { format })}
                </p>
              )}
              {ratioChanged && (
                <p className="mt-1 flex items-center gap-1 text-warning">
                  <AlertTriangle size={12} className="shrink-0" />
                  {t("assets.replace.ratioWarning")}
                </p>
              )}
            </div>
          </div>
        </div>

        <SheetFooter className="mx-auto w-full max-w-4xl flex-row items-center gap-2 px-6 pb-5 pt-1">
          <p className="min-w-0 flex-1 text-xs text-muted-foreground">
            {file
              ? t("assets.replace.cacheNote")
              : t("assets.replace.compareHint")}
          </p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={upload.isPending}
            onClick={close}
          >
            {t("assets.replace.cancel")}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!file || !formatOk || upload.isPending}
            onClick={confirm}
          >
            {upload.isPending ? <Spinner className="size-3.5" /> : null}
            {upload.isPending
              ? t("assets.replace.replacing")
              : t("assets.replace.confirm")}
          </Button>
        </SheetFooter>

        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          accept={acceptFor(item.key)}
          onChange={(e) => {
            const next = e.target.files?.[0];
            e.target.value = "";
            choose(next);
          }}
        />
      </SheetContent>
    </Sheet>
  );
}

function DeleteAssetDialog({
  configId,
  item,
  onClose,
  onDeleted,
}: {
  configId: string;
  item: PickerObject | null;
  onClose: () => void;
  onDeleted: (key: string) => void;
}) {
  const t = useT();
  const del = useFilePickerDelete();

  async function confirmDelete() {
    if (!item) return;
    try {
      await del.mutateAsync({ configId, key: item.key });
      toast.success(t("assets.browser.deleted"));
      onDeleted(item.key);
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
              name: item ? displayName(item.key) : "",
            })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={del.isPending}>
            {t("assets.browser.deleteCancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={del.isPending}
            onClick={(e) => {
              e.preventDefault();
              confirmDelete();
            }}
          >
            {del.isPending ? <Spinner className="size-3.5" /> : null}
            {t("assets.browser.deleteConfirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
