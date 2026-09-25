/**
 * Library — the org filesystem, as the drive of a computer.
 *
 * The product is one machine: an organization is the drive, and a project is a
 * folder in it (`project-folder.ts`). So this page is rooted rather than
 * absolute — `root` is the top of the tree it shows, the org's home folder for
 * the org destination and one project's folder inside a project. Everything
 * else follows from that: the breadcrumb starts there, search narrows under it,
 * and nothing above it is reachable by walking up.
 *
 * `?path=` holds the browse location, `?preview=` the open file, `?layout=` and
 * `?sort=` how the files are drawn — all four in the URL, so a folder, a file
 * and the way someone likes to read them are linkable and survive a reload.
 */

import { useRef, useState } from "react";
import { Page } from "@/components/page";
import { Panel } from "@/components/panel";
import { type LibraryFileView } from "./file-view";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useProjectContext } from "@/sdk";
import { toast } from "sonner";
import { useT } from "@/i18n/use-t.ts";
import { Eye, Plus, RefreshCw01, Upload01 } from "@untitledui/icons";
import { useIsMobile } from "@decocms/ui/hooks/use-mobile.ts";
import { Button } from "@decocms/ui/components/button.tsx";
import { IconButton } from "@decocms/ui/components/icon-button.tsx";
import { SearchToggle } from "@decocms/ui/components/search-toggle.tsx";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@decocms/ui/components/dialog.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import {
  HOME_MOUNT_PATH,
  homeDisplayName,
} from "@decocms/shared/organization/home-mount";
import { KEYS } from "@/lib/query-keys";
import { useDebouncedValue } from "@/hooks/use-debounced-value.ts";
import { useOrgFsMutations } from "@/hooks/use-org-fs";
import {
  basename,
  libraryTrail,
  parseLibraryPath,
  segmentLabel,
} from "./location";
import { LIBRARY_SORTS, type LibrarySort } from "./entries";
import { useOrgRepoSyncVolumes } from "@/hooks/use-org-repo-syncs";
import { BrandPreviewDialog } from "./brand-preview";
import { ShareDialog, type ShareTarget } from "./file-share-button";
import { LibraryPreviewDialog } from "./preview-dialog";
import { SkillPreviewDialog } from "./skill-preview";
import {
  LIBRARY_VOLUMES,
  type LibraryLayout,
  type ListingView,
  type PendingDelete,
  PublicSetsView,
  SearchResultsView,
  SYSTEM_FOLDER_NAMES,
  VolumeView,
} from "./library-views";

export function LibraryPage({
  root = HOME_MOUNT_PATH,
  rootLabel,
  onOpenFile: onOpenFileOverride,
  onOpenSkill: onOpenSkillOverride,
  onOpenBrand: onOpenBrandOverride,
}: {
  /** Top of the tree this page shows. Defaults to the org's drive. */
  root?: string;
  /** What to call that root in copy and in the breadcrumb. Defaults to the
   *  org's home-folder name. */
  rootLabel?: string;
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
    fileView?: LibraryFileView;
    layout?: LibraryLayout;
    sort?: LibrarySort;
    path?: string;
    preview?: string;
    skill?: string;
    brand?: string;
  };
  const fileView = search.fileView ?? "all";
  const layout: LibraryLayout = search.layout === "grid" ? "grid" : "list";
  const sort: LibrarySort = LIBRARY_SORTS.includes(search.sort as LibrarySort)
    ? (search.sort as LibrarySort)
    : "name";
  const setSearchParam = (
    key:
      | "path"
      | "preview"
      | "skill"
      | "brand"
      | "fileView"
      | "layout"
      | "sort",
    value: string | null,
  ) =>
    navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        [key]: value || undefined,
      }),
    });
  const setFileView = (view: LibraryFileView) =>
    setSearchParam("fileView", view === "all" ? null : view);
  const view: ListingView = {
    layout,
    sort,
    fileView,
    onLayout: (next) => setSearchParam("layout", next === "list" ? null : next),
    onSort: (next) => setSearchParam("sort", next === "name" ? null : next),
  };

  /** A missing (or emptied) `?path=` lands at the tree's root. */
  const browsePath = search.path || root;
  const parsedLocation = parseLibraryPath(browsePath);
  // Synced-repo volumes are mirrors of their GitHub source: local writes would
  // be deleted on the next sync cycle, so the Library browses them read-only
  // (same treatment as the public sets).
  const syncedVolumes = useOrgRepoSyncVolumes();
  const location =
    parsedLocation.volume !== null && syncedVolumes.has(parsedLocation.volume)
      ? { ...parsedLocation, readOnly: true }
      : parsedLocation;

  const onOpenDir = (path: string) => setSearchParam("path", path);
  const homeLabel = rootLabel ?? homeDisplayName(org.slug);
  const trail = libraryTrail(browsePath, root);
  const atRoot = trail.length === 0;
  const breadcrumbs = trail.map((crumb) => ({
    key: `folder:${crumb.path}`,
    label: crumb.label,
    onSelect: () => onOpenDir(crumb.path),
  }));
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

  /** Search follows the location: the whole tree at its root, this folder's
   *  subtree below it. `volume === null` is the public-sets listing, which has
   *  no single volume to scope to and so stays global. */
  const [searchText, setSearchText] = useState("");
  const searchQuery = useDebouncedValue(searchText.trim(), 300);
  const searchScope =
    !atRoot && location.volume !== null
      ? { volume: location.volume, prefix: location.dirPath }
      : undefined;
  const searchPlaceholder = searchScope
    ? t("library.library.searchInPlaceholder", {
        folder: segmentLabel(location.segments.at(-1) ?? ""),
      })
    : t("library.library.searchPlaceholder");
  // What to call the current folder in copy — never the internal "home".
  const locationLabel = atRoot
    ? homeLabel
    : segmentLabel(location.segments.at(-1) ?? "");

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

  // Every writer — upload, new folder, drag-move — acts on the folder being
  // browsed, so what you drop always shows up in the listing you're looking at.
  // (The `uploads` volume still receives chat attachments; that's a different
  // flow.) Read-only locations (public sets) allow none of it.
  const browseVolume = location.readOnly ? null : location.volume;
  const { upload, mkdir, move } = useOrgFsMutations(
    browseVolume ?? HOME_MOUNT_PATH,
  );
  // Deletes can target any volume (the recent feed is cross-volume), so they
  // get their own hook instance bound to the pending entry's volume.
  const { remove } = useOrgFsMutations(pendingDelete?.volume ?? "uploads");

  /** Reserved names belong to the DRIVE's root, not to every root: a project
   *  folder may hold its own `uploads` with nothing to collide with. */
  const isDriveRoot = location.isHomeRoot && root === HOME_MOUNT_PATH;

  async function handleUpload(files: FileList | null) {
    if (!browseVolume || !files || files.length === 0) return;
    try {
      await upload.mutateAsync({ dir: location.dirPath, files: [...files] });
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

  // Drag-and-drop upload — same destination as the Upload button: the folder
  // being browsed. Off in read-only locations.
  const canDrop = browseVolume !== null;

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
    // We own this file. Stop it bubbling to the chat composer's
    // window-level drop listener (input.tsx `useWindowFileDrop`), which
    // would otherwise upload the same file into the chat input too.
    e.stopPropagation();
    dragDepth.current = 0;
    setIsDragging(false);
    if (e.dataTransfer.files.length > 0) {
      void handleUpload(e.dataTransfer.files);
    }
  }

  async function handleCreateFolder() {
    const name = newFolderName.trim();
    if (!browseVolume || !name) return;
    if (isDriveRoot && SYSTEM_FOLDER_NAMES.has(name.toLowerCase())) {
      toast.error(t("library.library.folderNameReserved", { name }));
      return;
    }
    try {
      const dir = location.dirPath;
      await mkdir.mutateAsync(dir ? `${dir}/${name}` : name);
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
    // Same reserved names as folder creation — a rename is the other way to
    // land a hand-made folder on top of a system-folder card.
    if (
      renameTarget.kind === "dir" &&
      isDriveRoot &&
      SYSTEM_FOLDER_NAMES.has(newName.toLowerCase())
    ) {
      toast.error(t("library.library.folderNameReserved", { name: newName }));
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
    for (const volume of LIBRARY_VOLUMES) {
      queryClient.invalidateQueries({
        queryKey: KEYS.orgFsVolume(org.id, volume),
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

  // Right-clicking empty space creates a folder here. This listens on the whole
  // page, so anything interactive has to opt out first: entry rows that own a
  // rename menu call preventDefault, and everything else (the search box, the
  // toolbar, the rows with no menu of their own) keeps its native menu — a
  // right-click meant for "paste" must never become "new folder".
  function handleContextMenuEmpty(e: React.MouseEvent) {
    if (e.defaultPrevented || !browseVolume) return;
    if (
      (e.target as HTMLElement).closest(
        "input, textarea, button, a, [role='button']",
      )
    ) {
      return;
    }
    e.preventDefault();
    setNewFolderOpen(true);
  }

  /** Refresh, layout, new folder, upload — the controls both chromes show, in
   *  one place so they cannot drift into two different Libraries again. */
  const controls = (
    <>
      <IconButton
        label={t("library.library.refresh")}
        tooltipSide="bottom"
        /* `secondary`, like the search toggle it sits beside and the New
           folder button after it: a ghost icon in a row of outlined pills
           reads as a different class of control than it is. */
        variant="secondary"
        onClick={refresh}
      >
        <RefreshCw01 />
      </IconButton>
      {browseVolume && (
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setNewFolderOpen(true)}
          aria-label={t("library.library.newFolder")}
        >
          <Plus size={14} />
          <span className="hidden @lg/panel-header:inline">
            {t("library.library.newFolder")}
          </span>
        </Button>
      )}
    </>
  );

  const primaryAction = location.readOnly ? (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <Eye size={12} />
      {t("library.library.readOnly")}
    </span>
  ) : (
    <Button
      size="sm"
      disabled={upload.isPending}
      onClick={() => fileInputRef.current?.click()}
      aria-label={
        upload.isPending
          ? t("library.library.uploading")
          : t("library.library.uploadFile")
      }
    >
      <Upload01 size={14} />
      <span className="hidden @lg/panel-header:inline">
        {upload.isPending
          ? t("library.library.uploading")
          : t("library.library.uploadFile")}
      </span>
    </Button>
  );

  const fileViewTabs = (
    <Page.Tabs>
      {(["all", "documents", "media"] as const).map((tab) => (
        <Page.Tab
          key={tab}
          active={fileView === tab}
          onClick={() => void setFileView(tab)}
        >
          {t(`library.library.${tab}`)}
        </Page.Tab>
      ))}
    </Page.Tabs>
  );

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
              {t("library.library.dropToUpload", { location: locationLabel })}
            </p>
          </div>
        </div>
      )}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => void handleUpload(e.target.files)}
      />
      <Page.Breadcrumbs
        after="page"
        parent={{
          onSelect: () => onOpenDir(root),
          /** A rooted library names its own root; only spread when there IS one, so an empty label doesn't erase the route's own. */
          ...(rootLabel ? { label: rootLabel } : {}),
        }}
        items={breadcrumbs}
      />
      <Page.Actions
        secondary={
          <>
            <SearchToggle
              value={searchText}
              onChange={setSearchText}
              label={t("library.library.searchPlaceholder")}
              placeholder={searchPlaceholder}
              clearLabel={t("library.library.clearSearch")}
            />
            {controls}
          </>
        }
      >
        {primaryAction}
      </Page.Actions>
      <Panel.Toolbar.Left.Portal>{fileViewTabs}</Panel.Toolbar.Left.Portal>
      <div className="h-full overflow-y-auto">
        <div className="mx-auto flex w-full flex-col max-w-[1200px] gap-6 px-4 py-6 md:px-8">
          {searchQuery ? (
            <SearchResultsView
              view={view}
              query={searchQuery}
              scope={searchScope}
              stale={searchText.trim() !== searchQuery}
              onOpenFile={onOpenFile}
              onShare={setShareTarget}
              onDelete={setPendingDelete}
            />
          ) : location.volume === null ? (
            <PublicSetsView view={view} onOpenDir={onOpenDir} />
          ) : (
            <VolumeView
              view={view}
              root={root}
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
                path: locationLabel || t("library.library.theLibrary"),
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
