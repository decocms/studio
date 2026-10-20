/**
 * The Library's listings: folder tiles above, a sorted file table below.
 *
 * The files table has a second presentation, a thumbnail grid, for recognising
 * a file by its own first page. Its toggle lives in the Files heading because
 * it changes that section and nothing else.
 *
 * `entries.ts` normalizes every listing to the same records.
 */

import type { ComponentType, SVGProps } from "react";
import { useProjectContext } from "@/sdk";
import {
  type LibraryFileView,
  type LibraryModified,
  matchesLibraryFileView,
  matchesLibraryModified,
} from "./file-view";
import { Grid01, List, Palette, Zap } from "@untitledui/icons";
import { cn } from "@decocms/ui/lib/utils.ts";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import { EmptyState } from "@decocms/ui/components/empty-state.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { useChatNavigation } from "@/components/chat/hooks/use-chat-navigation";
import { FolderIcon } from "@/components/folder-icon";
import { ViewModeToggle } from "@decocms/ui/components/view-mode-toggle.tsx";
import { describeFileType } from "@/components/file-type-icon";
import { timeAgo } from "@/lib/format-time";
import {
  HOME_MOUNT_PATH,
  homeDisplayName,
} from "@decocms/shared/organization/home-mount";
import { useT } from "@/i18n/use-t.ts";
import {
  type OrgFsEntry,
  type OrgFsRecentEntry,
  type OrgFsSearchScope,
  type ShareMode,
  useOrgFsFileUrl,
  useOrgFsList,
  type OrgFsSourceThread,
  useOrgFsVolumeFiles,
  useOrgFsPublicSets,
  useOrgFsRecent,
  useOrgFsSearch,
} from "@/hooks/use-org-fs";
import { FileCard, type PublicState, PublicBadge } from "./cards";
import { EntryList, EntryRow, type EntryRowActions } from "./entry-row";
import { FOLDER_COUNT_LIMIT, FolderTile, FolderTiles } from "./folder-tile";
import { AgentAvatar } from "@/components/agent-icon";
import { useVirtualMCPsNonBlocking } from "@/sdk";
import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import { scopableProjects } from "@/hooks/use-project-scope";
import {
  PROJECTS_FOLDER,
  projectFolderName,
} from "@decocms/shared/organization/project-folder";
import {
  type LibraryEntry,
  type LibrarySort,
  sortEntries,
  toLibraryEntry,
} from "./entries";
import {
  basename,
  browsePathFor,
  browsePathForEntry,
  isGeneratedId,
  type LibraryLocation,
  namedFolderOf,
  publicSetOf,
  segmentLabel,
} from "./location";
import type { ShareTarget } from "./file-share-button";
import { curateRecents } from "./recents";

/** List or grid, for the Files section. */
export type LibraryLayout = "list" | "grid";

/** Absolute proxy link to copy when sharing a file. */
function publicFileUrl(path: string): string {
  return `${window.location.origin}${path}`;
}

/** Badge state for a list entry: shared here (public/password), inherited from
 *  a parent, or not shared. */
function publicStateOf(e: {
  shareMode?: ShareMode;
  readPublic?: boolean;
  effectivePublic?: boolean;
}): PublicState | undefined {
  if (e.shareMode === "password") return "password";
  if (e.shareMode === "public" || e.readPublic) return "public";
  if (e.effectivePublic) return "inherited";
  return undefined;
}

/** The volumes every sandbox mounts (see file-storage/mount/provisioning.ts) —
 *  what the refresh button revalidates. The Library presents `home` as the top
 *  of the tree and the rest as system folders inside it. */
export const LIBRARY_VOLUMES = [HOME_MOUNT_PATH, "uploads", "outputs"] as const;

/** Volumes filled by chat and by agent work rather than by hand, presented as
 *  places of their own. Their mounts are unchanged — only the presentation
 *  moved (and `public` presents as "skills", see `segmentLabel`). */
const SYSTEM_FOLDERS = ["uploads", "outputs"] as const;

/** The names the home listing already occupies with system-folder cards. A
 *  hand-made folder with one of these names would sit in the same grid under
 *  the same label but point somewhere else, so the writers reject it at the
 *  home root. Lowercased — "Uploads" reads as the same folder to a human.
 *
 *  `projects` is here for a different reason: it is a REAL folder in the home
 *  volume — the one holding a folder per project — and it is pinned to the top
 *  of the drive rather than sorted in with the rest. */
export const SYSTEM_FOLDER_NAMES: ReadonlySet<string> = new Set([
  ...SYSTEM_FOLDERS,
  PROJECTS_FOLDER,
  segmentLabel("public"),
]);

/** One row at a typical width. */
const RECENT_COUNT = 4;

/** The folder a cross-volume hit lives in — its NAME, since a full path
 *  truncates to nothing in this column. Volume root falls back to the
 *  volume. */
function locationOf(volume: string, path: string, orgSlug: string): string {
  const dir = namedFolderOf(path);
  if (dir) return segmentLabel(basename(dir));
  const set = publicSetOf(volume);
  if (set) return set;
  return volume === HOME_MOUNT_PATH ? homeDisplayName(orgSlug) : volume;
}

/** Create drag-drop handlers for a library entry. */
function makeDragHandlers(
  path: string,
  kind: "file" | "dir",
  callbacks: {
    onDragStart?: (path: string) => void;
    onContextMenu?: (path: string, kind: "file" | "dir") => void;
    onDrop?: (fromPath: string, toPath: string) => void;
  },
) {
  return {
    onDragStart: (ev: React.DragEvent) => {
      callbacks.onDragStart?.(path);
      ev.dataTransfer.effectAllowed = "move";
      ev.dataTransfer.setData("application/x-studio-library-path", path);
    },
    onContextMenu: (ev: React.MouseEvent) => {
      ev.preventDefault();
      callbacks.onContextMenu?.(path, kind);
    },
    onDrop: callbacks.onDrop
      ? (ev: React.DragEvent) => {
          ev.preventDefault();
          const fromPath = ev.dataTransfer.getData(
            "application/x-studio-library-path",
          );
          if (
            fromPath &&
            fromPath !== path &&
            !path.startsWith(fromPath + "/")
          ) {
            callbacks.onDrop!(fromPath, path);
          }
        }
      : undefined,
  };
}

export interface PendingDelete {
  volume: string;
  path: string;
  kind: "file" | "dir";
}

/** How a listing is ordered and drawn — one object, none of it the listing's
 *  own state. */
export interface ListingView {
  layout: LibraryLayout;
  onLayout: (layout: LibraryLayout) => void;
  sort: LibrarySort;
  onSort: (sort: LibrarySort) => void;
  fileView: LibraryFileView;
  modified: LibraryModified;
  /** The file whose preview is open beside the list, as a browse path. */
  previewPath?: string;
}

/** The two filters, as one test. */
function matchesView(
  entry: { path: string; updatedAt: string },
  view: ListingView,
): boolean {
  return (
    matchesLibraryFileView(entry.path, view.fileView) &&
    matchesLibraryModified(entry.updatedAt, view.modified)
  );
}

/** Table or thumbnails: two states, so a toggle rather than a menu. */
export function LayoutToggle({
  layout,
  onChange,
}: {
  layout: LibraryLayout;
  onChange: (layout: LibraryLayout) => void;
}) {
  const t = useT();
  return (
    <ViewModeToggle
      value={layout}
      onValueChange={onChange}
      options={[
        {
          value: "list",
          icon: <List />,
          tooltip: t("library.entries.listView"),
        },
        {
          value: "grid",
          icon: <Grid01 />,
          tooltip: t("library.entries.gridView"),
        },
      ]}
    />
  );
}

/** A section heading: what this is, how many, and its own control. */
function SectionHead({
  label,
  count,
  action,
}: {
  label: string;
  count?: number;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex h-7 items-center justify-between gap-3">
      <h2 className="flex items-baseline gap-2 text-sm font-medium text-foreground">
        {label}
        {count !== undefined && count > 0 && (
          <span className="text-meta">{count}</span>
        )}
      </h2>
      {action}
    </div>
  );
}

function Section({
  label,
  count,
  action,
  children,
}: {
  label: string;
  count?: number;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <SectionHead label={label} count={count} action={action} />
      {children}
    </section>
  );
}

function CardsGrid({ children }: { children: React.ReactNode }) {
  return (
    <div className="@container">
      <div className="grid grid-cols-1 gap-3 @[440px]:grid-cols-2 @[660px]:grid-cols-3 @[980px]:grid-cols-4">
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

function ListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-px">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-11 rounded-lg" />
      ))}
    </div>
  );
}

function ListingSkeleton({ layout }: { layout: LibraryLayout }) {
  return layout === "grid" ? <GridSkeleton rows={2} /> : <ListSkeleton />;
}

function EmptyNote({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}

/** One file, in whichever presentation the Files section is in. The grid
 *  always shows the thumbnail — that is the only reason to be in one. */
function FileEntry({
  entry,
  view,
  secondary,
  publicState,
  downloadUrl,
  selected,
  actions,
}: {
  entry: LibraryEntry;
  view: ListingView;
  selected?: boolean;
  secondary?: string;
  publicState?: PublicState;
  downloadUrl: string;
  actions: EntryRowActions;
}) {
  if (view.layout === "list") {
    return (
      <EntryRow
        entry={entry}
        selected={selected}
        secondary={secondary}
        publicState={publicState}
        actions={actions}
      />
    );
  }
  return (
    <FileCard
      size={entry.size}
      filename={entry.name}
      downloadUrl={downloadUrl}
      subtitle={`${secondary ?? describeFileType(entry.name)} · ${timeAgo(entry.updatedAt)}`}
      publicState={publicState}
      selected={selected}
      onOpen={actions.onOpen}
      onShare={actions.onShare}
      onDelete={actions.onDelete}
      draggable={actions.draggable}
      onDragStart={actions.onDragStart}
      onContextMenu={actions.onContextMenu}
    />
  );
}

/** The Files section: its heading, its layout toggle, and its entries. */
function FilesSection({
  view,
  count,
  label,
  locationLabel,
  note,
  children,
}: {
  view: ListingView;
  count?: number;
  label?: string;
  /** Names the folder column, in a cross-volume feed. */
  locationLabel?: string;
  /** A caption beside the heading, such as a cut-off list. */
  note?: string;
  children: React.ReactNode;
}) {
  const t = useT();
  return (
    <Section
      label={label ?? t("library.libraryViews.files")}
      count={count}
      action={note && <span className="text-meta">{note}</span>}
    >
      {view.layout === "grid" ? (
        <CardsGrid>{children}</CardsGrid>
      ) : (
        <EntryList
          sort={view.sort}
          onSort={view.onSort}
          locationLabel={locationLabel}
        >
          {children}
        </EntryList>
      )}
    </Section>
  );
}
/** A skill's or a brand's mark, in place of the folder art: opening one
 *  previews it rather than listing it. */
function KindMark({
  Glyph,
}: {
  Glyph: ComponentType<SVGProps<SVGSVGElement>>;
}) {
  return (
    <span className="flex size-6 items-center justify-center rounded-md bg-primary/10 text-primary">
      <Glyph className="size-3.5" />
    </span>
  );
}

/** The project each folder under `projects/` belongs to. Non-blocking and
 *  allowed to be empty: the avatar is decoration on a correct tile. */
function useProjectsByFolder(): Map<string, VirtualMCPEntity> {
  const all = useVirtualMCPsNonBlocking();
  const byFolder = new Map<string, VirtualMCPEntity>();
  for (const project of scopableProjects(all)) {
    byFolder.set(projectFolderName(project), project);
  }
  return byFolder;
}

/**
 * Search results, shown in place of whatever listing is active while the search
 * box has a query. Across the whole tree at its root, narrowed to the current
 * folder's subtree everywhere else (`scope`) — so the placeholder's promise
 * ("Search files in decks") is what actually happens.
 */
export function SearchResultsView({
  query,
  scope,
  stale,
  view,
  onOpenFile,
  onShare,
  onDelete,
}: {
  query: string;
  /** Narrow to one volume + directory subtree; unset = cross-volume. */
  scope?: OrgFsSearchScope;
  /** The input is ahead of `query` (still inside the debounce window). */
  stale: boolean;
  view: ListingView;
  onOpenFile: (previewPath: string) => void;
  onShare: (target: ShareTarget) => void;
  onDelete: (pending: PendingDelete) => void;
}) {
  const t = useT();
  const { org } = useProjectContext();
  const fileUrl = useOrgFsFileUrl();
  const search = useOrgFsSearch(query, scope);

  const shareFile = (e: OrgFsEntry & { volume: string }) =>
    onShare({
      volume: e.volume,
      path: e.path,
      kind: "file",
      shareMode: e.shareMode ?? "private",
      effectivePublic: e.effectivePublic ?? false,
      url: publicFileUrl(fileUrl(e.volume, e.path)),
    });

  if (search.isPending) return <ListingSkeleton layout={view.layout} />;
  const results = (search.data ?? []).filter((entry) =>
    matchesView(entry, view),
  );
  if (results.length === 0) {
    return (
      <EmptyNote>{t("library.libraryViews.noFilesMatch", { query })}</EmptyNote>
    );
  }
  /** Sorting loses which volume a hit came from — two volumes can hold the
   *  same path — so the raw hit is carried alongside its sorted record. */
  const sorted = sortEntries(results.map(toLibraryEntry), view.sort).map(
    (item) => ({
      item,
      hit: results.find((e) => e.path === item.path)!,
    }),
  );

  return (
    <div
      className={cn(
        // Dim while showing results for a previous query.
        (stale || search.isPlaceholderData) && "opacity-50",
      )}
    >
      <FilesSection
        view={view}
        label={t("library.libraryViews.results")}
        locationLabel={t("library.entries.location")}
        count={results.length}
      >
        {sorted.map(({ item, hit: e }) => {
          // Hits from the shared public sets are read-only: no share/delete.
          const readOnly = publicSetOf(e.volume) !== null;
          const downloadUrl = fileUrl(e.volume, e.path);
          const previewPath = browsePathForEntry(e.volume, e.path);
          return (
            <FileEntry
              key={`${e.volume}/${e.path}`}
              entry={item}
              view={view}
              selected={view.previewPath === previewPath}
              secondary={locationOf(e.volume, e.path, org.slug)}
              publicState={publicStateOf(e)}
              downloadUrl={downloadUrl}
              actions={{
                onOpen: () => onOpenFile(previewPath),
                download: { url: downloadUrl, filename: item.name },
                onShare: readOnly ? undefined : () => shareFile(e),
                onDelete: readOnly
                  ? undefined
                  : () =>
                      onDelete({
                        volume: e.volume,
                        path: e.path,
                        kind: "file",
                      }),
              }}
            />
          );
        })}
      </FilesSection>
    </div>
  );
}

/** Cross-volume recents (see `recents.ts`), so only at the drive root. */
function Recent({
  view,
  onOpenFile,
}: {
  view: ListingView;
  onOpenFile: (previewPath: string) => void;
}) {
  const t = useT();
  const { org } = useProjectContext();
  const recent = useOrgFsRecent();
  const fileUrl = useOrgFsFileUrl();

  if (recent.isPending) return null;
  const items = curateRecents(
    (recent.data ?? []).filter((e) => matchesView(e, view)),
    RECENT_COUNT,
  );
  if (items.length === 0) return null;

  const captionOf = (entry: OrgFsRecentEntry, more: number) =>
    [
      locationOf(entry.volume, entry.path, org.slug),
      timeAgo(entry.updatedAt),
      more > 0 && t("library.libraryViews.moreInFolder", { count: more }),
    ]
      .filter(Boolean)
      .join(" · ");

  return (
    <Section label={t("library.libraryViews.recent")}>
      <div className="@container">
        <div className="grid grid-cols-2 gap-3 @[720px]:grid-cols-4">
          {items.map(({ entry, more }) => {
            const previewPath = browsePathForEntry(entry.volume, entry.path);
            const name = basename(entry.path);
            return (
              <FileCard
                key={`${entry.volume}/${entry.path}`}
                size={entry.size}
                filename={name}
                downloadUrl={fileUrl(entry.volume, entry.path)}
                subtitle={captionOf(entry, more)}
                publicState={publicStateOf(entry)}
                selected={view.previewPath === previewPath}
                compact
                onOpen={() => onOpenFile(previewPath)}
              />
            );
          })}
        </div>
      </div>
    </Section>
  );
}

/** Volumes the product fills one chat folder at a time. */
const CHAT_VOLUMES: ReadonlySet<string> = new Set(SYSTEM_FOLDERS);

export function isChatVolume(volume: string | null): boolean {
  return volume !== null && CHAT_VOLUMES.has(volume);
}

/** A chat-filled volume as its files: the chat-id folders, mostly empty, give
 *  way to the files inside them. Folders a person named still lead. */
export function ChatFilesView({
  volume,
  view,
  onOpenDir,
  onOpenFile,
  onShare,
  onDelete,
  emptyActions,
}: {
  volume: string;
  view: ListingView;
  onOpenDir: (path: string) => void;
  onOpenFile: (previewPath: string) => void;
  onShare: (target: ShareTarget) => void;
  onDelete: (pending: PendingDelete) => void;
  emptyActions?: React.ReactNode;
}) {
  const t = useT();
  const fileUrl = useOrgFsFileUrl();
  const volumeFiles = useOrgFsVolumeFiles(volume);
  const rootListing = useOrgFsList(volume, "");
  const { navigateToTask } = useChatNavigation();

  if (volumeFiles.isPending || rootListing.isPending) {
    return <ListingSkeleton layout={view.layout} />;
  }
  const failed = volumeFiles.error ?? rootListing.error;
  if (failed) {
    return (
      <p className="text-sm text-destructive">
        {failed instanceof Error
          ? failed.message
          : t("library.libraryViews.failedToLoad")}
      </p>
    );
  }
  const pages = volumeFiles.data?.pages ?? [];
  const all = pages.flatMap((page) => page.entries);
  const threads: Record<string, OrgFsSourceThread> = Object.assign(
    {},
    ...pages.map((page) => page.threads),
  );
  const sourceOf = new Map(
    all.map((e) => [
      e.path,
      e.sourceThreadId
        ? { id: e.sourceThreadId, ...threads[e.sourceThreadId] }
        : undefined,
    ]),
  );
  const files = all.filter((e) => matchesView(e, view));
  const folders = (rootListing.data ?? []).filter(
    (e) => e.kind === "dir" && !isGeneratedId(basename(e.path)),
  );

  if (files.length === 0 && folders.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-border">
        <EmptyState
          illustration={<FolderIcon className="size-16" />}
          title={t("library.libraryViews.emptyFolder")}
          description={t("library.libraryViews.emptyFolderHint")}
          buttonComponent={emptyActions}
        />
      </div>
    );
  }

  const folderTiles = folders.length > 0 && (
    <Section label={t("library.libraryViews.folders")} count={folders.length}>
      <FolderTiles>
        {folders.map((e, index) => (
          <FolderTile
            key={e.path}
            name={basename(e.path)}
            counts={{
              volume,
              path: e.path,
              enabled: index < FOLDER_COUNT_LIMIT,
            }}
            onOpen={() => onOpenDir(browsePathForEntry(volume, e.path))}
            onDelete={() => onDelete({ volume, path: e.path, kind: "dir" })}
          />
        ))}
      </FolderTiles>
    </Section>
  );
  if (files.length === 0) return folderTiles;

  const sorted = sortEntries(files.map(toLibraryEntry), view.sort);
  return (
    <>
      {folderTiles}
      <FilesSection
        view={view}
        count={files.length}
        locationLabel={t("library.libraryViews.sourceChat")}
      >
        {sorted.map((item) => {
          const previewPath = browsePathForEntry(volume, item.path);
          const downloadUrl = fileUrl(volume, item.path);
          const source = sourceOf.get(item.path);
          return (
            <FileEntry
              key={item.path}
              entry={item}
              view={view}
              secondary={source?.title}
              selected={view.previewPath === previewPath}
              publicState={publicStateOf(item.entry)}
              downloadUrl={downloadUrl}
              actions={{
                onOpen: () => onOpenFile(previewPath),
                onOpenSecondary:
                  source?.agentId !== undefined
                    ? () =>
                        navigateToTask(source.id, {
                          virtualMcpId: source.agentId,
                        })
                    : undefined,
                download: { url: downloadUrl, filename: item.name },
                onShare: () =>
                  onShare({
                    volume,
                    path: item.path,
                    kind: "file",
                    shareMode: item.entry.shareMode ?? "private",
                    effectivePublic: item.entry.effectivePublic ?? false,
                    url: publicFileUrl(downloadUrl),
                  }),
                onDelete: () =>
                  onDelete({ volume, path: item.path, kind: "file" }),
              }}
            />
          );
        })}
      </FilesSection>
      {volumeFiles.hasNextPage && (
        <Button
          variant="outline"
          className="self-center"
          disabled={volumeFiles.isFetchingNextPage}
          onClick={() => void volumeFiles.fetchNextPage()}
        >
          {t("library.libraryViews.loadMore")}
        </Button>
      )}
    </>
  );
}

/** Listing for `public` — one read-only folder per configured set. */
export function PublicSetsView({
  view,
  onOpenDir,
}: {
  view: ListingView;
  onOpenDir: (path: string) => void;
}) {
  const t = useT();
  const publicSets = useOrgFsPublicSets();
  if (publicSets.isPending) return <ListingSkeleton layout={view.layout} />;
  const sets = publicSets.data ?? [];
  if (sets.length === 0) {
    return (
      <EmptyNote>
        {t("library.libraryViews.noPublicSkillSetsConfigured")}
      </EmptyNote>
    );
  }
  return (
    <Section label={t("library.libraryViews.folders")} count={sets.length}>
      <FolderTiles>
        {sets.map((set) => (
          <FolderTile
            key={set}
            name={set}
            readOnly
            counts={{ volume: `public-${set}`, path: "", enabled: true }}
            onOpen={() => onOpenDir(`public/${set}`)}
          />
        ))}
      </FolderTiles>
    </Section>
  );
}

/**
 * Listing of one directory inside a volume — and, at the drive root, the
 * Library's landing view: the pinned folders lead and the cross-volume
 * "Recently added" feed closes the page.
 */
export function VolumeView({
  location,
  root,
  onOpenDir,
  view,
  onOpenFile,
  onOpenSkill,
  onOpenBrand,
  onShare,
  onDelete,
  onDragStart,
  onContextMenu,
  onMove,
  emptyActions,
}: {
  location: LibraryLocation;
  /** The browse path this tree is rooted at — the drive, or one project's
   *  folder. Only the drive root carries the pinned folders and the feed. */
  root: string;
  onOpenDir: (path: string) => void;
  view: ListingView;
  onOpenFile: (previewPath: string) => void;
  onOpenSkill: (skillPath: string) => void;
  onOpenBrand: (brandPath: string) => void;
  onShare: (target: ShareTarget) => void;
  onDelete: (pending: PendingDelete) => void;
  onDragStart?: (path: string) => void;
  onContextMenu?: (path: string, kind: "file" | "dir") => void;
  onMove?: (fromPath: string, toDir: string) => void;
  /** What an empty, writable folder offers: upload and new folder. */
  emptyActions?: React.ReactNode;
}) {
  const t = useT();
  const { org } = useProjectContext();
  const volume = location.volume ?? "";
  const listing = useOrgFsList(volume, location.dirPath);
  const fileUrl = useOrgFsFileUrl();
  const projectsByFolder = useProjectsByFolder();
  const isDriveRoot = location.isHomeRoot && root === HOME_MOUNT_PATH;
  /** Inside `projects/`, a folder IS a project, so it wears that project's
   *  avatar. */
  const inProjectsFolder =
    volume === HOME_MOUNT_PATH && location.dirPath === PROJECTS_FOLDER;

  /** A pre-existing folder colliding with a pinned name still renders, and
   *  carries its path to tell it from the volume card. */
  const disambiguate = (name: string) =>
    isDriveRoot && SYSTEM_FOLDER_NAMES.has(name.toLowerCase())
      ? `${homeDisplayName(org.slug)}/${name}`
      : undefined;

  const recent = isDriveRoot ? (
    <Recent view={view} onOpenFile={onOpenFile} />
  ) : null;

  if (listing.isPending) {
    return (
      <>
        {recent}
        <ListingSkeleton layout={view.layout} />
      </>
    );
  }
  if (listing.isError) {
    return (
      <p className="text-sm text-destructive">
        {listing.error instanceof Error
          ? listing.error.message
          : t("library.libraryViews.failedToLoad")}
      </p>
    );
  }

  const raw = listing.data ?? [];
  /** `projects` is pinned above, so the listing must not draw it a second time. */
  const entries = raw.filter(
    (e) =>
      !(
        isDriveRoot &&
        e.kind === "dir" &&
        basename(e.path) === PROJECTS_FOLDER
      ),
  );

  // An empty root still has the recent feed to show.
  if (entries.length === 0 && !isDriveRoot) {
    return (
      /* Dashed, because the whole page takes a drop and this says so. */
      <div className="rounded-2xl border border-dashed border-border">
        <EmptyState
          illustration={<FolderIcon className="size-16" />}
          title={t("library.libraryViews.emptyFolder")}
          description={t(
            location.readOnly
              ? "library.libraryViews.emptyReadOnlySet"
              : "library.libraryViews.emptyFolderHint",
          )}
          buttonComponent={location.readOnly ? undefined : emptyActions}
        />
      </div>
    );
  }

  const deleteFor = (entry: OrgFsEntry) =>
    location.readOnly
      ? undefined
      : () => onDelete({ volume, path: entry.path, kind: entry.kind });

  // Read-only volumes (public skill sets) can't be published.
  const shareFor = (entry: OrgFsEntry) =>
    location.readOnly
      ? undefined
      : () =>
          onShare({
            volume,
            path: entry.path,
            kind: entry.kind,
            shareMode: entry.shareMode ?? "private",
            effectivePublic: entry.effectivePublic ?? false,
            url:
              entry.kind === "file"
                ? publicFileUrl(fileUrl(volume, entry.path))
                : undefined,
          });

  /** Filters narrow files only: a folder is how a person reaches the files
   *  that match, and its own `updatedAt` does not move with its children. */
  const skills = entries.filter((e) => e.kind === "dir" && e.hasSkill);
  // Skill wins over brand if a dir somehow carries both markers.
  const brands = entries.filter(
    (e) => e.kind === "dir" && e.hasBrand && !e.hasSkill,
  );
  const dirs = entries.filter(
    (e) => e.kind === "dir" && !e.hasSkill && !e.hasBrand,
  );
  const files = entries.filter(
    (e) => e.kind === "file" && matchesView(e, view),
  );
  const sortedFiles = sortEntries(files.map(toLibraryEntry), view.sort);

  /** Folders lead, whatever the sort: `sortEntries` groups them. */
  const rows = sortEntries(
    [...skills, ...brands, ...dirs, ...files].map(toLibraryEntry),
    view.sort,
  );
  const openFor = (item: LibraryEntry): (() => void) => {
    const path = browsePathFor(location, item.path);
    switch (item.kind) {
      case "folder":
        return () => onOpenDir(path);
      case "skill":
        return () => onOpenSkill(path);
      case "brand":
        return () => onOpenBrand(path);
      case "file":
        return () => onOpenFile(path);
      default: {
        const unhandled: never = item.kind;
        return unhandled;
      }
    }
  };

  /** One list, the way Finder and Dropbox show a folder: what is in it, with
   *  nothing above it competing for the eye. */
  const table = rows.length > 0 && (
    <EntryList sort={view.sort} onSort={view.onSort}>
      {rows.map((item) => {
        const path = browsePathFor(location, item.path);
        const project = inProjectsFolder
          ? projectsByFolder.get(item.name)
          : undefined;
        const previewable = item.kind === "skill" || item.kind === "brand";
        return (
          <EntryRow
            key={item.path}
            entry={project?.title ? { ...item, name: project.title } : item}
            selected={item.kind === "file" && view.previewPath === path}
            publicState={publicStateOf(item.entry)}
            actions={{
              onOpen: openFor(item),
              onBrowse: previewable ? () => onOpenDir(path) : undefined,
              download:
                item.kind === "file"
                  ? { url: fileUrl(volume, item.path), filename: item.name }
                  : undefined,
              onShare: item.kind === "brand" ? undefined : shareFor(item.entry),
              onDelete: deleteFor(item.entry),
              draggable: !location.readOnly,
              ...makeDragHandlers(
                item.path,
                item.kind === "file" ? "file" : "dir",
                {
                  onDragStart,
                  onContextMenu,
                  onDrop: item.kind === "folder" ? onMove : undefined,
                },
              ),
            }}
          />
        );
      })}
    </EntryList>
  );

  return (
    <>
      {recent}
      {view.layout === "list" ? (
        table
      ) : (
        <>
          {dirs.length + skills.length + brands.length > 0 && (
            <Section
              label={t("library.libraryViews.folders")}
              count={dirs.length + skills.length + brands.length}
            >
              <FolderTiles>
                {skills.map((e) => {
                  const publicState = publicStateOf(e);
                  return (
                    <FolderTile
                      key={e.path}
                      name={basename(e.path)}
                      meta={t("library.cards.skill")}
                      icon={<KindMark Glyph={Zap} />}
                      badge={
                        publicState && <PublicBadge state={publicState} t={t} />
                      }
                      onOpen={() =>
                        onOpenSkill(browsePathFor(location, e.path))
                      }
                      onBrowse={() =>
                        onOpenDir(browsePathFor(location, e.path))
                      }
                      onShare={shareFor(e)}
                      onDelete={deleteFor(e)}
                      draggable={!location.readOnly}
                      {...makeDragHandlers(e.path, "dir", {
                        onDragStart,
                        onContextMenu,
                      })}
                    />
                  );
                })}
                {brands.map((e) => (
                  <FolderTile
                    key={e.path}
                    name={basename(e.path)}
                    meta={t("library.cards.brand")}
                    icon={<KindMark Glyph={Palette} />}
                    onOpen={() => onOpenBrand(browsePathFor(location, e.path))}
                    onBrowse={() => onOpenDir(browsePathFor(location, e.path))}
                    onDelete={deleteFor(e)}
                    draggable={!location.readOnly}
                    {...makeDragHandlers(e.path, "dir", {
                      onDragStart,
                      onContextMenu,
                    })}
                  />
                ))}
                {dirs.map((e, index) => {
                  const name = basename(e.path);
                  const project = inProjectsFolder
                    ? projectsByFolder.get(name)
                    : undefined;
                  const publicState = publicStateOf(e);
                  return (
                    <FolderTile
                      key={e.path}
                      name={project?.title ?? name}
                      meta={disambiguate(name)}
                      readOnly={location.readOnly}
                      counts={{
                        volume,
                        path: e.path,
                        enabled: index < FOLDER_COUNT_LIMIT,
                      }}
                      overlay={
                        project && (
                          <AgentAvatar
                            icon={project.icon}
                            name={project.title}
                            size="xs"
                          />
                        )
                      }
                      badge={
                        publicState && <PublicBadge state={publicState} t={t} />
                      }
                      onOpen={() => onOpenDir(browsePathFor(location, e.path))}
                      onShare={shareFor(e)}
                      onDelete={deleteFor(e)}
                      draggable={!location.readOnly}
                      {...makeDragHandlers(e.path, "dir", {
                        onDragStart,
                        onContextMenu,
                        onDrop: onMove,
                      })}
                    />
                  );
                })}
              </FolderTiles>
            </Section>
          )}
          {sortedFiles.length > 0 && (
            <FilesSection view={view} count={sortedFiles.length}>
              {sortedFiles.map((item) => (
                <FileEntry
                  key={item.path}
                  entry={item}
                  view={view}
                  selected={
                    view.previewPath === browsePathFor(location, item.path)
                  }
                  publicState={publicStateOf(item.entry)}
                  downloadUrl={fileUrl(volume, item.path)}
                  actions={{
                    onOpen: () =>
                      onOpenFile(browsePathFor(location, item.path)),
                    download: {
                      url: fileUrl(volume, item.path),
                      filename: item.name,
                    },
                    onShare: shareFor(item.entry),
                    onDelete: deleteFor(item.entry),
                    draggable: !location.readOnly,
                    ...makeDragHandlers(item.path, "file", {
                      onDragStart,
                      onContextMenu,
                    }),
                  }}
                />
              ))}
            </FilesSection>
          )}
        </>
      )}
      {(view.fileView !== "all" || view.modified !== "any") &&
        files.length === 0 && (
          <EmptyNote>{t("library.library.noFilesInView")}</EmptyNote>
        )}
    </>
  );
}
