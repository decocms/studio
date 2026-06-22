/**
 * Library (/$org/files) — the org filesystem as a Drive-like home (Figma
 * qFc7wr91 node 7870-5644). Replaces the settings → Files table browser.
 *
 * Root: "Recently added" (cross-volume `/fs/recent` feed) + Folders
 * (volumes and public sets) + "All files". Browsing into a folder swaps to
 * a breadcrumbed listing of that directory in the same card language.
 * Browse location lives in `?path=` and the open preview in `?preview=`,
 * so both are linkable and survive reload.
 */

import { useRef, useState } from "react";
import type { ComponentType, SVGProps } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useProjectContext } from "@decocms/mesh-sdk";
import { toast } from "sonner";
import {
  ChevronRight,
  Eye,
  Globe01,
  Home01,
  Plus,
  RefreshCw01,
  Stars01,
  Upload01,
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
import { Skeleton } from "@deco/ui/components/skeleton.tsx";
import { homeMountPath } from "@/file-storage/home-mount";
import { ErrorBoundary } from "@/web/components/error-boundary";
import { FileTypeIcon } from "@/web/components/file-type-icon";
import { Toolbar } from "@/web/layouts/agent-shell-layout/toolbar";
import { HeaderTabButton } from "@/web/layouts/main-panel-tabs/header-tab-button";
import { KEYS } from "@/web/lib/query-keys";
import {
  type OrgFsEntry,
  useOrgFsFileUrl,
  useOrgFsList,
  useOrgFsMutations,
  useOrgFsPublicSets,
  useOrgFsRecent,
  useOrgFsUsage,
} from "@/web/hooks/use-org-fs";
import {
  FileCard,
  FolderCard,
  RecentFileCard,
  SkillCard,
  timeAgo,
} from "./cards";
import {
  basename,
  browsePathFor,
  type LibraryLocation,
  parseLibraryPath,
} from "./location";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/web/components/resizable";
import { LibraryPreviewDialog } from "./preview-dialog";
import { LibraryPreviewPanel } from "./preview-panel";
import { SkillPreviewDialog } from "./skill-preview-dialog";

/** The volumes every sandbox mounts (see file-storage/mount/provisioning.ts).
 *  `glyph` marks the folder body, Finder-special-folder style. Skills are
 *  deliberately absent — they live in versioned repos (public sets), not as
 *  an editable cloud volume. */
const VOLUMES = [
  { id: "home", description: "Your organization's home folder", glyph: Home01 },
  { id: "uploads", description: "Files your team uploads", glyph: Upload01 },
  { id: "outputs", description: "Agent run outputs", glyph: Stars01 },
] as const;

const RECENTLY_ADDED_COUNT = 3;

interface PendingDelete {
  volume: string;
  path: string;
  kind: "file" | "dir";
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="text-[13px] text-foreground">{children}</p>;
}

function CardsGrid({ children }: { children: React.ReactNode }) {
  return (
    <div className="@container">
      <div className="grid grid-cols-1 gap-3 @sm:grid-cols-2 @lg:grid-cols-3">
        {children}
      </div>
    </div>
  );
}

function GridSkeleton({ rows = 1 }: { rows?: number }) {
  return (
    <CardsGrid>
      {Array.from({ length: rows * 3 }, (_, i) => (
        <Skeleton key={i} className="h-16 rounded-2xl" />
      ))}
    </CardsGrid>
  );
}

function EmptyNote({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}

function VolumeFolderCard({
  volume,
  displayName,
  description,
  glyph,
  onOpen,
}: {
  volume: string;
  /** Card label when it differs from the volume id (home shows the slug). */
  displayName?: string;
  description: string;
  glyph?: ComponentType<SVGProps<SVGSVGElement>>;
  onOpen: () => void;
}) {
  const usage = useOrgFsUsage(volume);
  return (
    <FolderCard
      name={displayName ?? volume}
      meta={usage.data ? `${usage.data.files} files` : undefined}
      subtitle={description}
      glyph={glyph}
      onOpen={onOpen}
    />
  );
}

function Breadcrumbs({
  segments,
  onNavigate,
}: {
  segments: string[];
  onNavigate: (path: string) => void;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1 text-sm">
      <button
        type="button"
        className="text-muted-foreground hover:text-foreground hover:underline"
        onClick={() => onNavigate("")}
      >
        Library
      </button>
      {segments.map((seg, i) => {
        const prefix = segments.slice(0, i + 1).join("/");
        const isLast = i === segments.length - 1;
        return (
          <span key={prefix} className="flex min-w-0 items-center gap-1">
            <ChevronRight
              size={12}
              className="shrink-0 text-muted-foreground"
            />
            {isLast ? (
              <span className="truncate font-medium text-foreground">
                {seg}
              </span>
            ) : (
              <button
                type="button"
                className="truncate text-muted-foreground hover:text-foreground hover:underline"
                onClick={() => onNavigate(prefix)}
              >
                {seg}
              </button>
            )}
          </span>
        );
      })}
    </div>
  );
}

/** Root view: Recently added + Folders (volumes/public) + All files. */
function RootView({
  onOpenDir,
  onOpenFile,
  onDelete,
}: {
  onOpenDir: (path: string) => void;
  onOpenFile: (previewPath: string) => void;
  onDelete: (pending: PendingDelete) => void;
}) {
  const { org } = useProjectContext();
  const recent = useOrgFsRecent();
  const publicSets = useOrgFsPublicSets();
  const fileUrl = useOrgFsFileUrl();

  const entries = recent.data ?? [];
  const recentlyAdded = entries.slice(0, RECENTLY_ADDED_COUNT);
  const allFiles = entries.slice(RECENTLY_ADDED_COUNT);

  return (
    <>
      {recent.isPending ? (
        <div className="flex flex-col gap-3">
          <SectionLabel>Recently added</SectionLabel>
          <GridSkeleton />
        </div>
      ) : recentlyAdded.length > 0 ? (
        <div className="flex flex-col gap-3">
          <SectionLabel>Recently added</SectionLabel>
          <CardsGrid>
            {recentlyAdded.map((e) => (
              <RecentFileCard
                key={`${e.volume}/${e.path}`}
                filename={basename(e.path)}
                updatedAt={e.updatedAt}
                size={e.size}
                downloadUrl={fileUrl(e.volume, e.path)}
                onOpen={() => onOpenFile(`${e.volume}/${e.path}`)}
                onDelete={() =>
                  onDelete({ volume: e.volume, path: e.path, kind: "file" })
                }
              />
            ))}
          </CardsGrid>
        </div>
      ) : (
        <EmptyNote>
          No files yet — upload one, or ask an agent to produce something.
        </EmptyNote>
      )}

      <div className="flex flex-col gap-3">
        <SectionLabel>Folders</SectionLabel>
        <CardsGrid>
          {VOLUMES.map((v) => (
            <VolumeFolderCard
              key={v.id}
              volume={v.id}
              // The home volume presents as the org itself — through the same
              // helper provisioning uses, so the label always matches the
              // sandbox mount (incl. the reserved-slug fallback to "home",
              // which avoids two cards both named e.g. "public").
              displayName={
                v.id === "home" ? homeMountPath(org.slug) : undefined
              }
              description={v.description}
              glyph={v.glyph}
              onOpen={() => onOpenDir(v.id)}
            />
          ))}
          {(publicSets.data?.length ?? 0) > 0 && (
            <FolderCard
              name="public"
              meta={`${publicSets.data?.length} sets`}
              subtitle="Curated skill sets — read-only"
              glyph={Globe01}
              readOnly
              onOpen={() => onOpenDir("public")}
            />
          )}
        </CardsGrid>
      </div>

      {allFiles.length > 0 && (
        <div className="flex flex-col gap-3">
          <SectionLabel>All files</SectionLabel>
          <CardsGrid>
            {allFiles.map((e) => (
              <FileCard
                key={`${e.volume}/${e.path}`}
                filename={basename(e.path)}
                updatedAt={e.updatedAt}
                downloadUrl={fileUrl(e.volume, e.path)}
                onOpen={() => onOpenFile(`${e.volume}/${e.path}`)}
                onDelete={() =>
                  onDelete({ volume: e.volume, path: e.path, kind: "file" })
                }
              />
            ))}
          </CardsGrid>
        </div>
      )}
    </>
  );
}

/** Listing for `public` — one read-only folder per configured set. */
function PublicSetsView({ onOpenDir }: { onOpenDir: (path: string) => void }) {
  const publicSets = useOrgFsPublicSets();
  if (publicSets.isPending) return <GridSkeleton />;
  const sets = publicSets.data ?? [];
  if (sets.length === 0) {
    return <EmptyNote>No public skill sets are configured.</EmptyNote>;
  }
  return (
    <CardsGrid>
      {sets.map((set) => (
        <FolderCard
          key={set}
          name={set}
          subtitle="Read-only"
          readOnly
          onOpen={() => onOpenDir(`public/${set}`)}
        />
      ))}
    </CardsGrid>
  );
}

/** Listing of one directory inside a volume. */
function VolumeView({
  location,
  onOpenDir,
  onOpenFile,
  onOpenSkill,
  onDelete,
}: {
  location: LibraryLocation;
  onOpenDir: (path: string) => void;
  onOpenFile: (previewPath: string) => void;
  onOpenSkill: (skillPath: string) => void;
  onDelete: (pending: PendingDelete) => void;
}) {
  const volume = location.volume ?? "";
  const listing = useOrgFsList(volume, location.dirPath);
  const fileUrl = useOrgFsFileUrl();

  if (listing.isPending) return <GridSkeleton rows={2} />;
  if (listing.isError) {
    return (
      <p className="text-sm text-destructive">
        {listing.error instanceof Error
          ? listing.error.message
          : "Failed to load"}
      </p>
    );
  }

  const entries = listing.data ?? [];
  const skills = entries.filter((e) => e.kind === "dir" && e.hasSkill);
  const dirs = entries.filter((e) => e.kind === "dir" && !e.hasSkill);
  const files = entries.filter((e) => e.kind === "file");

  if (entries.length === 0) {
    return (
      <EmptyNote>
        {location.readOnly
          ? "Empty — this read-only set syncs from its GitHub source."
          : "Empty folder — upload a file or create a folder to get started."}
      </EmptyNote>
    );
  }

  const deleteFor = (entry: OrgFsEntry) =>
    location.readOnly
      ? undefined
      : () => onDelete({ volume, path: entry.path, kind: entry.kind });

  return (
    <>
      {skills.length > 0 && (
        <div className="flex flex-col gap-3">
          <SectionLabel>Skills</SectionLabel>
          <CardsGrid>
            {skills.map((e) => (
              <SkillCard
                key={e.path}
                dirName={basename(e.path)}
                updatedAt={e.updatedAt}
                skillMdUrl={fileUrl(volume, `${e.path}/SKILL.md`)}
                onOpen={() => onOpenSkill(browsePathFor(location, e.path))}
                onBrowse={() => onOpenDir(browsePathFor(location, e.path))}
                onDelete={deleteFor(e)}
              />
            ))}
          </CardsGrid>
        </div>
      )}
      {dirs.length > 0 && (
        <div className="flex flex-col gap-3">
          <SectionLabel>Folders</SectionLabel>
          <CardsGrid>
            {dirs.map((e) => (
              <FolderCard
                key={e.path}
                name={basename(e.path)}
                meta={timeAgo(e.updatedAt)}
                readOnly={location.readOnly}
                onOpen={() => onOpenDir(browsePathFor(location, e.path))}
                onDelete={deleteFor(e)}
              />
            ))}
          </CardsGrid>
        </div>
      )}
      {files.length > 0 && (
        <div className="flex flex-col gap-3">
          <SectionLabel>Files</SectionLabel>
          <CardsGrid>
            {files.map((e) => (
              <FileCard
                key={e.path}
                filename={basename(e.path)}
                updatedAt={e.updatedAt}
                downloadUrl={fileUrl(volume, e.path)}
                onOpen={() => onOpenFile(browsePathFor(location, e.path))}
                onDelete={deleteFor(e)}
              />
            ))}
          </CardsGrid>
        </div>
      )}
    </>
  );
}

function LibraryPage() {
  const { org } = useProjectContext();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const search = useSearch({ strict: false }) as {
    path?: string;
    preview?: string;
    skill?: string;
  };
  const browsePath = search.path ?? "";
  const location = parseLibraryPath(browsePath);
  const isRoot = location.segments.length === 0;

  const setSearchParam = (
    key: "path" | "preview" | "skill",
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
  const onOpenFile = (previewPath: string) =>
    setSearchParam("preview", previewPath);
  const onOpenSkill = (skillPath: string) => setSearchParam("skill", skillPath);

  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(
    null,
  );
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Root uploads land in the uploads volume root — visible org-wide, outside
  // any thread folder (those belong to chat-attachment flows).
  const uploadVolume = location.readOnly
    ? null
    : (location.volume ?? "uploads");
  const uploadDir = location.volume ? location.dirPath : "";
  const { upload, mkdir } = useOrgFsMutations(uploadVolume ?? "uploads");
  // Deletes can target any volume (the root feed is cross-volume), so they
  // get their own hook instance bound to the pending entry's volume.
  const { remove } = useOrgFsMutations(pendingDelete?.volume ?? "uploads");

  async function handleUpload(files: FileList | null) {
    if (!uploadVolume || !files || files.length === 0) return;
    try {
      await upload.mutateAsync({ dir: uploadDir, files: [...files] });
      toast.success(
        files.length === 1
          ? `Uploaded ${files[0]?.name}`
          : `Uploaded ${files.length} files`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function handleCreateFolder() {
    const name = newFolderName.trim();
    if (!uploadVolume || !name) return;
    try {
      await mkdir.mutateAsync(uploadDir ? `${uploadDir}/${name}` : name);
      toast.success(`Folder "${name}" created`);
      setNewFolderOpen(false);
      setNewFolderName("");
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to create folder",
      );
    }
  }

  async function handleDelete() {
    if (!pendingDelete) return;
    const entry = pendingDelete;
    try {
      await remove.mutateAsync(entry.path);
      toast.success(`Deleted ${basename(entry.path)}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setPendingDelete(null);
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
    queryClient.invalidateQueries({ queryKey: KEYS.orgFsPublicSets(org.id) });
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[900px] flex-col gap-10 px-6 py-10 lg:px-10">
        <div className="flex flex-col gap-2">
          {!isRoot && (
            <Breadcrumbs segments={location.segments} onNavigate={onOpenDir} />
          )}
          <div className="flex items-center gap-2">
            <h1 className="min-w-0 flex-1 truncate text-xl font-medium text-foreground">
              {isRoot ? "Library" : (location.segments.at(-1) ?? "Library")}
            </h1>
            <Button
              variant="ghost"
              size="icon"
              onClick={refresh}
              aria-label="Refresh"
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
                New folder
              </Button>
            )}
            {location.readOnly ? (
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Eye size={12} />
                Read-only
              </span>
            ) : (
              <Button
                size="sm"
                disabled={upload.isPending}
                onClick={() => fileInputRef.current?.click()}
              >
                <Upload01 size={14} />
                {upload.isPending ? "Uploading…" : "Upload file"}
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

        {isRoot ? (
          <RootView
            onOpenDir={onOpenDir}
            onOpenFile={onOpenFile}
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
            onDelete={setPendingDelete}
          />
        )}
      </div>

      {/* Preview wins over skill: opening a bundled file hides the skill
          dialog; closing it falls back to the still-set ?skill=. On desktop
          the preview renders as a side panel (in the outer Library), so only
          mobile uses the dialog here. */}
      {search.preview ? (
        isMobile && (
          <LibraryPreviewDialog
            previewPath={search.preview}
            onClose={() => setSearchParam("preview", null)}
          />
        )
      ) : search.skill ? (
        <SkillPreviewDialog
          key={search.skill}
          skillPath={search.skill}
          onClose={() => setSearchParam("skill", null)}
        />
      ) : null}

      <Dialog open={newFolderOpen} onOpenChange={setNewFolderOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New folder</DialogTitle>
            <DialogDescription>
              Create a folder in {browsePath || "the library"}.
            </DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            placeholder="folder-name"
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleCreateFolder();
            }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewFolderOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!newFolderName.trim() || mkdir.isPending}
              onClick={() => void handleCreateFolder()}
            >
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {pendingDelete ? basename(pendingDelete.path) : ""}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete?.kind === "dir"
                ? "The folder and everything inside it will be deleted for the whole organization. Sandboxes see this change within seconds."
                : "The file will be deleted for the whole organization. Sandboxes see this change within seconds."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void handleDelete()}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export default function Library() {
  const isMobile = useIsMobile();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { preview?: string };
  const previewPath = search.preview;
  const previewName = previewPath ? basename(previewPath) : "";
  const closePreview = () =>
    navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        preview: undefined,
      }),
    });

  if (isMobile) {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
        <ErrorBoundary>
          <LibraryPage />
        </ErrorBoundary>
      </div>
    );
  }

  // Desktop: chat-style two-panel group — Library on the left and, when a
  // file is open (`?preview=`), its preview as a tab-like panel on the right.
  return (
    <ResizablePanelGroup
      direction="horizontal"
      className="min-h-0 flex-1 pt-0 pr-1 pb-1 pl-0"
    >
      <ResizablePanel order={1} minSize={30} defaultSize={55}>
        <div className="h-full p-0.5 pt-0.25">
          <div className="card-shadow flex h-full flex-col overflow-hidden rounded-[0.75rem] bg-background">
            <ErrorBoundary>
              <LibraryPage />
            </ErrorBoundary>
          </div>
        </div>
      </ResizablePanel>
      {previewPath && (
        <>
          {/* Mirror the chat: an open file surfaces as a pill in the shared
              top-right tab slot; clicking it closes the preview. */}
          <Toolbar.Tabs>
            <HeaderTabButton
              title={previewName}
              icon={{
                kind: "component",
                Component: (props) => (
                  <FileTypeIcon filename={previewName} {...props} />
                ),
              }}
              active
              onClick={closePreview}
            />
          </Toolbar.Tabs>
          <ResizableHandle className="bg-sidebar" />
          <ResizablePanel order={2} minSize={25} defaultSize={45}>
            <div className="h-full p-0.5 pt-0.25">
              <div className="card-shadow flex h-full flex-col overflow-hidden rounded-[0.75rem] bg-background">
                <ErrorBoundary>
                  <LibraryPreviewPanel
                    previewPath={previewPath}
                    onClose={closePreview}
                  />
                </ErrorBoundary>
              </div>
            </div>
          </ResizablePanel>
        </>
      )}
    </ResizablePanelGroup>
  );
}
