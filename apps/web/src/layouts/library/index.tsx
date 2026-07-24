/**
 * Library (/$org/files) — the org filesystem as a Drive-like home (Figma
 * qFc7wr91 node 7870-5644). Replaces the settings → Files table browser.
 *
 * A global search box (cross-volume `/fs/search`) sits above every view;
 * typing swaps the active listing for its results. Root: "Recently added"
 * (cross-volume `/fs/recent` feed) + Folders (volumes and public sets).
 * Browsing into a folder swaps to a breadcrumbed listing of that directory
 * in the same card language. Browse location lives in `?path=` and the open
 * preview in `?preview=`, so both are linkable and survive reload.
 */

import { useRef, useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useProjectContext } from "@/sdk";
import { toast } from "sonner";
import { useT } from "@/i18n/use-t.ts";
import {
  Eye,
  Plus,
  RefreshCw01,
  SearchLg,
  Upload01,
  XClose,
} from "@untitledui/icons";
import { useIsMobile } from "@deco/ui/hooks/use-mobile.ts";
import { Button } from "@deco/ui/components/button.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@deco/ui/components/alert-dialog.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import { KEYS } from "@/lib/query-keys";
import { useDebouncedValue } from "@/hooks/use-debounced-value.ts";
import { useOrgFsMutations } from "@/hooks/use-org-fs";
import { basename, parseLibraryPath } from "./location";
import { BrandPreviewDialog } from "./brand-preview";
import { ShareDialog, type ShareTarget } from "./file-share-button";
import { LibraryPreviewDialog } from "./preview-dialog";
import { SkillPreviewDialog } from "./skill-preview";
import {
  Breadcrumbs,
  type PendingDelete,
  PublicSetsView,
  RootView,
  SearchResultsView,
  VOLUMES,
  VolumeView,
} from "./library-views";

export function LibraryPage({
  onOpenFile: onOpenFileOverride,
  onOpenSkill: onOpenSkillOverride,
  onOpenBrand: onOpenBrandOverride,
}: {
  /** Override file-open behaviour (e.g. open as a panel tab instead of ?preview=). */
  onOpenFile?: (previewPath: string) => void;
  onOpenSkill?: (skillPath: string) => void;
  onOpenBrand?: (brandPath: string) => void;
} = {}) {
  const t = useT();
  const { org } = useProjectContext();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const search = useSearch({ strict: false }) as {
    path?: string;
    preview?: string;
    skill?: string;
    brand?: string;
  };
  const browsePath = search.path ?? "";
  const location = parseLibraryPath(browsePath);
  const isRoot = location.segments.length === 0;

  const setSearchParam = (
    key: "path" | "preview" | "skill" | "brand",
    value: string | null,
  ) =>
    navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        [key]: value || undefined,
      }),
    });
  const onOpenDir = (path: string) => setSearchParam("path", path);
  // preview/skill/brand share the single right panel, so opening one clears
  // the others — otherwise a second one just queues behind the precedence
  // order (preview › skill › brand) and only shows once the first is closed.
  const openPreview = (kind: "preview" | "skill" | "brand", value: string) =>
    navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        preview: undefined,
        skill: undefined,
        brand: undefined,
        [kind]: value,
      }),
    });
  const onOpenFile =
    onOpenFileOverride ??
    ((previewPath: string) => openPreview("preview", previewPath));
  const onOpenSkill =
    onOpenSkillOverride ??
    ((skillPath: string) => openPreview("skill", skillPath));
  const onOpenBrand =
    onOpenBrandOverride ??
    ((brandPath: string) => openPreview("brand", brandPath));

  // Global file search — cross-volume, so it lives above the browse
  // location and stays visible while inside any folder.
  const [searchText, setSearchText] = useState("");
  const searchQuery = useDebouncedValue(searchText.trim(), 300);

  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(
    null,
  );
  const [shareTarget, setShareTarget] = useState<ShareTarget | null>(null);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<{
    path: string;
    kind: "file" | "dir";
  } | null>(null);
  const [renameName, setRenameName] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  // Depth counter so dragenter/leave bubbling from child cards doesn't flicker.
  const dragDepth = useRef(0);

  // Root uploads land in the uploads volume root — visible org-wide, outside
  // any thread folder (those belong to chat-attachment flows).
  const uploadVolume = location.readOnly
    ? null
    : (location.volume ?? "uploads");
  const uploadDir = location.volume ? location.dirPath : "";
  const { upload, mkdir, move } = useOrgFsMutations(uploadVolume ?? "uploads");
  // Deletes can target any volume (the root feed is cross-volume), so they
  // get their own hook instance bound to the pending entry's volume.
  const { remove } = useOrgFsMutations(pendingDelete?.volume ?? "uploads");

  async function handleUpload(files: FileList | null) {
    if (!uploadVolume || !files || files.length === 0) return;
    try {
      await upload.mutateAsync({ dir: uploadDir, files: [...files] });
      toast.success(
        files.length === 1
          ? t("library.library.uploadedSingle", {
              filename: files[0]?.name ?? "",
            })
          : t("library.library.uploadedMultiple", { count: files.length }),
      );
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t("library.library.uploadFailed"),
      );
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  // Drag-and-drop upload — same destination as the Upload button: the current
  // folder, or the uploads volume at root. Off in read-only locations.
  const canDrop = uploadVolume !== null;
  const dropLabel = isRoot
    ? "uploads"
    : (location.segments.at(-1) ?? "this folder");

  function dragHasFiles(e: React.DragEvent) {
    return e.dataTransfer.types.includes("Files");
  }
  function handleDragEnter(e: React.DragEvent) {
    if (!canDrop || !dragHasFiles(e)) return;
    e.preventDefault();
    dragDepth.current += 1;
    setIsDragging(true);
  }
  function handleDragOver(e: React.DragEvent) {
    if (!canDrop || !dragHasFiles(e)) return;
    e.preventDefault(); // required so the drop event fires
  }
  function handleDragLeave() {
    if (!canDrop) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setIsDragging(false);
  }
  function handleDrop(e: React.DragEvent) {
    if (!canDrop) return;
    e.preventDefault();
    dragDepth.current = 0;
    setIsDragging(false);
    if (e.dataTransfer.files.length > 0) {
      void handleUpload(e.dataTransfer.files);
    }
  }

  async function handleCreateFolder() {
    const name = newFolderName.trim();
    if (!uploadVolume || !name) return;
    try {
      await mkdir.mutateAsync(uploadDir ? `${uploadDir}/${name}` : name);
      toast.success(t("library.library.folderCreated", { name }));
      setNewFolderOpen(false);
      setNewFolderName("");
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : t("library.library.folderCreateFailed"),
      );
    }
  }

  async function handleDelete() {
    if (!pendingDelete) return;
    const entry = pendingDelete;
    try {
      await remove.mutateAsync(entry.path);
      toast.success(
        t("library.library.deleted", { name: basename(entry.path) }),
      );
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t("library.library.deleteFailed"),
      );
    } finally {
      setPendingDelete(null);
    }
  }

  async function handleRename() {
    if (!renameTarget) return;
    const newName = renameName.trim();
    if (
      !newName ||
      newName.includes("/") ||
      newName.includes("..") ||
      newName === basename(renameTarget.path)
    ) {
      setRenameOpen(false);
      setRenameTarget(null);
      setRenameName("");
      return;
    }
    try {
      const dir = renameTarget.path.includes("/")
        ? renameTarget.path.slice(0, renameTarget.path.lastIndexOf("/"))
        : "";
      const newPath = dir ? `${dir}/${newName}` : newName;
      await move.mutateAsync({ from: renameTarget.path, to: newPath });
      const displayName = newName.replace(/[<>]/g, "");
      toast.success(t("library.library.renamed", { name: displayName }));
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t("library.library.renameFailed"),
      );
    } finally {
      setRenameOpen(false);
      setRenameTarget(null);
      setRenameName("");
    }
  }

  async function handleMove(fromPath: string, toDir: string) {
    try {
      const fromName = basename(fromPath);
      const newPath = toDir ? `${toDir}/${fromName}` : fromName;
      await move.mutateAsync({ from: fromPath, to: newPath });
      toast.success(
        t("library.library.moved", {
          name: fromName,
          destination: toDir || t("library.library.theLibrary"),
        }),
      );
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t("library.library.moveFailed"),
      );
    }
  }

  function refresh() {
    for (const v of VOLUMES) {
      queryClient.invalidateQueries({
        queryKey: KEYS.orgFsVolume(org.id, v.id),
      });
    }
    if (location.volume) {
      queryClient.invalidateQueries({
        queryKey: KEYS.orgFsVolume(org.id, location.volume),
      });
    }
    queryClient.invalidateQueries({ queryKey: KEYS.orgFsRecent(org.id) });
    queryClient.invalidateQueries({ queryKey: KEYS.orgFsSearchRoot(org.id) });
    queryClient.invalidateQueries({ queryKey: KEYS.orgFsPublicSets(org.id) });
  }

  function handleContextMenuEmpty(e: React.MouseEvent) {
    if (!isRoot || location.readOnly || !uploadVolume) return;
    e.preventDefault();
    setNewFolderOpen(true);
  }

  return (
    <div
      className="relative h-full"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onContextMenu={handleContextMenuEmpty}
    >
      {isDragging && (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-background/80 p-6 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-primary px-10 py-8 text-center">
            <Upload01 size={28} className="text-primary" />
            <p className="text-sm font-medium text-foreground">
              {t("library.library.dropToUpload", { location: dropLabel })}
            </p>
          </div>
        </div>
      )}
      <div className="h-full overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[900px] flex-col gap-10 px-6 py-10 lg:px-10">
          <div className="flex flex-col gap-2">
            {!isRoot && (
              <Breadcrumbs
                segments={location.segments}
                onNavigate={onOpenDir}
              />
            )}
            <div className="flex items-center gap-2">
              <h1 className="min-w-0 flex-1 truncate text-xl font-medium text-foreground">
                {isRoot
                  ? t("library.library.title")
                  : (location.segments.at(-1) ?? t("library.library.title"))}
              </h1>
              <Button
                variant="ghost"
                size="icon"
                onClick={refresh}
                aria-label={t("library.library.refresh")}
              >
                <RefreshCw01 size={14} />
              </Button>
              {!isRoot && uploadVolume && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setNewFolderOpen(true)}
                >
                  <Plus size={14} />
                  {t("library.library.newFolder")}
                </Button>
              )}
              {location.readOnly ? (
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Eye size={12} />
                  {t("library.library.readOnly")}
                </span>
              ) : (
                <Button
                  size="sm"
                  disabled={upload.isPending}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Upload01 size={14} />
                  {upload.isPending
                    ? t("library.library.uploading")
                    : t("library.library.uploadFile")}
                </Button>
              )}
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={(e) => void handleUpload(e.target.files)}
              />
            </div>
          </div>

          <div className="relative">
            <SearchLg
              size={16}
              className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setSearchText("");
              }}
              placeholder={t("library.library.searchPlaceholder")}
              className="h-10 rounded-xl pr-9 pl-9"
            />
            {searchText && (
              <Button
                variant="ghost"
                size="icon"
                className="absolute top-1/2 right-1.5 size-7 -translate-y-1/2"
                onClick={() => setSearchText("")}
                aria-label={t("library.library.clearSearch")}
              >
                <XClose size={14} />
              </Button>
            )}
          </div>

          {searchQuery ? (
            <SearchResultsView
              query={searchQuery}
              stale={searchText.trim() !== searchQuery}
              onOpenFile={onOpenFile}
              onShare={setShareTarget}
              onDelete={setPendingDelete}
            />
          ) : isRoot ? (
            <RootView
              onOpenDir={onOpenDir}
              onOpenFile={onOpenFile}
              onShare={setShareTarget}
              onDelete={setPendingDelete}
            />
          ) : location.volume === null ? (
            <PublicSetsView onOpenDir={onOpenDir} />
          ) : (
            <VolumeView
              // remount on volume switch so list state never bleeds across
              key={location.volume}
              location={location}
              onOpenDir={onOpenDir}
              onOpenFile={onOpenFile}
              onOpenSkill={onOpenSkill}
              onOpenBrand={onOpenBrand}
              onShare={setShareTarget}
              onDelete={setPendingDelete}
              onContextMenu={(path, kind) => {
                setRenameTarget({ path, kind });
                setRenameName(basename(path));
                setRenameOpen(true);
              }}
              onMove={handleMove}
            />
          )}
        </div>
      </div>

      {/* Preview/skill/brand each render as a right-side panel on desktop
          (in the outer Library), so only mobile uses these dialogs.
          Precedence — preview, then skill, then brand — mirrors the panel
          selection in the outer Library. */}
      {isMobile &&
        (search.preview ? (
          <LibraryPreviewDialog
            previewPath={search.preview}
            onClose={() => setSearchParam("preview", null)}
          />
        ) : search.skill ? (
          <SkillPreviewDialog
            key={search.skill}
            skillPath={search.skill}
            onClose={() => setSearchParam("skill", null)}
          />
        ) : search.brand ? (
          <BrandPreviewDialog
            key={search.brand}
            brandPath={search.brand}
            onClose={() => setSearchParam("brand", null)}
          />
        ) : null)}

      <Dialog open={newFolderOpen} onOpenChange={setNewFolderOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("library.library.newFolderTitle")}</DialogTitle>
            <DialogDescription>
              {t("library.library.newFolderDescription", {
                path: browsePath || t("library.library.theLibrary"),
              })}
            </DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            placeholder={t("library.library.folderNamePlaceholder")}
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleCreateFolder();
            }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewFolderOpen(false)}>
              {t("library.library.cancel")}
            </Button>
            <Button
              disabled={!newFolderName.trim() || mkdir.isPending}
              onClick={() => void handleCreateFolder()}
            >
              {t("library.library.create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={renameOpen}
        onOpenChange={(open) => {
          setRenameOpen(open);
          if (!open) {
            setRenameTarget(null);
            setRenameName("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {renameTarget &&
                t("library.library.renameTitle", {
                  name: basename(renameTarget.path),
                })}
            </DialogTitle>
            <DialogDescription>
              {t("library.library.renameDescription")}
            </DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            value={renameName}
            onChange={(e) => setRenameName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleRename();
            }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameOpen(false)}>
              {t("library.library.cancel")}
            </Button>
            <Button
              disabled={!renameName.trim() || move.isPending}
              onClick={() => void handleRename()}
            >
              {t("library.library.rename")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ShareDialog
        target={shareTarget}
        onOpenChange={(open) => {
          if (!open) setShareTarget(null);
        }}
      />

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("library.library.deleteTitle", {
                name: pendingDelete ? basename(pendingDelete.path) : "",
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete?.kind === "dir"
                ? t("library.library.deleteDirectoryDescription")
                : t("library.library.deleteFileDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("library.library.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void handleDelete()}>
              {t("library.library.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
