/**
 * The Library's listings.
 *
 * Folders above, files below, and they are drawn differently on purpose. A
 * FOLDER is a place you decide whether to enter, and that decision is made on
 * recognition, so folders are tiles. A FILE is scanned against its neighbours —
 * newest, biggest, the one from Tuesday — so files are a sorted table. Mixing
 * the two into one undifferentiated list is what the Library used to do, and it
 * served neither.
 *
 * The files table has a second presentation, a thumbnail grid, because
 * recognising a file by its own first page is the one thing a table cannot do.
 * The toggle lives in the Files heading rather than the page header: it changes
 * that section and nothing else.
 *
 * `entries.ts` normalizes every listing to the same records, so each of these
 * is one way of drawing one shape.
 */

import type { ComponentType, SVGProps } from "react";
import { useProjectContext } from "@/sdk";
import { type LibraryFileView, matchesLibraryFileView } from "./file-view";
import {
  Folder,
  Grid01,
  List,
  Stars01,
  Upload01,
  Zap,
} from "@untitledui/icons";
import { cn } from "@decocms/ui/lib/utils.ts";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import {
  HOME_MOUNT_PATH,
  homeDisplayName,
} from "@decocms/shared/organization/home-mount";
import { useT } from "@/i18n/use-t.ts";
import {
  type OrgFsEntry,
  type OrgFsSearchScope,
  type ShareMode,
  useOrgFsFileUrl,
  useOrgFsList,
  useOrgFsPublicSets,
  useOrgFsRecent,
  useOrgFsSearch,
  useOrgFsUsage,
} from "@/hooks/use-org-fs";
import {
  BrandCard,
  FileCard,
  type PublicState,
  PublicBadge,
  SkillCard,
} from "./cards";
import { EntryList, EntryRow, type EntryRowActions } from "./entry-row";
import { FOLDER_COUNT_LIMIT, FolderTile, FolderTiles } from "./folder-tile";
import { AgentAvatar } from "@/components/agent-icon";
import { useVirtualMCPsNonBlocking } from "@/sdk";
import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import { scopableProjects } from "@/hooks/use-project-scope";
import { PROJECTS_FOLDER, projectFolderName } from "./project-folder";
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
  type LibraryLocation,
  publicSetOf,
  segmentLabel,
} from "./location";
import type { ShareTarget } from "./file-share-button";
import { SyncedRepoFolders } from "./synced-repos";

/** List or grid — see the module docblock for which answers what. */
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
 *  system folders inside the home listing: graphite tone + a body glyph, so it
 *  reads as "the product owns this". Their mounts are unchanged — only the
 *  presentation moved (and `public` presents as "skills", see `segmentLabel`). */
const SYSTEM_FOLDERS = [
  {
    volume: "uploads",
    descriptionKey: "library.libraryViews.volumeUploadsDescription" as const,
    glyph: Upload01,
  },
  {
    volume: "outputs",
    descriptionKey: "library.libraryViews.volumeOutputsDescription" as const,
    glyph: Stars01,
  },
] as const;

/** The names the home listing already occupies with system-folder cards. A
 *  hand-made folder with one of these names would sit in the same grid under
 *  the same label but point somewhere else, so the writers reject it at the
 *  home root. Lowercased — "Uploads" reads as the same folder to a human.
 *
 *  `projects` is here for a different reason: it is a REAL folder in the home
 *  volume — the one holding a folder per project — and it is pinned to the top
 *  of the drive rather than sorted in with the rest. */
export const SYSTEM_FOLDER_NAMES: ReadonlySet<string> = new Set([
  ...SYSTEM_FOLDERS.map((f) => f.volume),
  PROJECTS_FOLDER,
  segmentLabel("public"),
]);

const RECENTLY_ADDED_COUNT = 12;

/**
 * The folder a cross-volume hit lives in — its name, not its path.
 *
 * A full path truncates to "rafaelvalls-local/…" in a column this narrow,
 * which tells you nothing. The containing folder's own name is what a reader
 * is actually asking for ("which decks folder?"), and it is the only part that
 * fits. Entries at a volume's root fall back to the volume, which IS their
 * folder.
 */
function locationOf(volume: string, path: string, orgSlug: string): string {
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
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

/** How a listing is ordered and drawn. Passed down as one object because every
 *  listing needs all of it and none of it is the listing's own state. */
export interface ListingView {
  layout: LibraryLayout;
  onLayout: (layout: LibraryLayout) => void;
  sort: LibrarySort;
  onSort: (sort: LibrarySort) => void;
  fileView: LibraryFileView;
}

/** Table or thumbnails, for the Files section. Two states, so it is a toggle
 *  and not a menu: the choice is worth exactly one click. */
function LayoutToggle({
  layout,
  onChange,
}: {
  layout: LibraryLayout;
  onChange: (layout: LibraryLayout) => void;
}) {
  const t = useT();
  const options = [
    { value: "list", Icon: List, label: t("library.entries.listView") },
    { value: "grid", Icon: Grid01, label: t("library.entries.gridView") },
  ] as const;
  return (
    <div className="flex h-7 items-center gap-0.5 rounded-lg border border-border p-0.5">
      {options.map(({ value, Icon, label }) => (
        <button
          key={value}
          type="button"
          aria-label={label}
          aria-pressed={layout === value}
          title={label}
          onClick={() => onChange(value)}
          className={cn(
            "flex size-6 items-center justify-center rounded-md transition-colors",
            layout === value
              ? "bg-accent text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <Icon size={13} />
        </button>
      ))}
    </div>
  );
}

/**
 * A section heading: what this is, how many, and the section's own control.
 *
 * Small on purpose — one step above the rows and no more. A page whose headings
 * out-shout their content makes you read the furniture before the work.
 */
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
          <span className="text-xs tabular-nums text-muted-foreground">
            {count}
          </span>
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
    <section className="flex flex-col gap-2">
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

/**
 * One file, in whichever presentation the Files section is in.
 *
 * The grid always shows the thumbnail. Reading a file's own first page is the
 * only reason to be in a grid at all — a grid of type icons is a table with
 * worse density.
 */
function FileEntry({
  entry,
  view,
  secondary,
  publicState,
  downloadUrl,
  actions,
}: {
  entry: LibraryEntry;
  view: ListingView;
  secondary?: string;
  publicState?: PublicState;
  downloadUrl: string;
  actions: EntryRowActions;
}) {
  if (view.layout === "list") {
    return (
      <EntryRow
        entry={entry}
        secondary={secondary}
        publicState={publicState}
        actions={actions}
      />
    );
  }
  return (
    <FileCard
      layout="media"
      size={entry.size}
      filename={entry.name}
      updatedAt={entry.updatedAt}
      downloadUrl={downloadUrl}
      subtitle={secondary}
      publicState={publicState}
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
  typeLabel,
  label,
  children,
}: {
  view: ListingView;
  count?: number;
  typeLabel: string;
  label?: string;
  children: React.ReactNode;
}) {
  const t = useT();
  return (
    <Section
      label={label ?? t("library.libraryViews.files")}
      count={count}
      action={<LayoutToggle layout={view.layout} onChange={view.onLayout} />}
    >
      {view.layout === "grid" ? (
        <CardsGrid>{children}</CardsGrid>
      ) : (
        <EntryList sort={view.sort} onSort={view.onSort} typeLabel={typeLabel}>
          {children}
        </EntryList>
      )}
    </Section>
  );
}
/** A volume rendered as a folder, with the file count the volume already
 *  knows — no listing needed, so no per-tile request. */
function VolumeFolderTile({
  volume,
  glyph,
  onOpen,
}: {
  volume: string;
  glyph?: ComponentType<SVGProps<SVGSVGElement>>;
  onOpen: () => void;
}) {
  const t = useT();
  const usage = useOrgFsUsage(volume);
  return (
    <FolderTile
      name={volume}
      meta={
        usage.data
          ? t("library.libraryViews.filesCount", { count: usage.data.files })
          : undefined
      }
      glyph={glyph}
      tone="system"
      onOpen={onOpen}
    />
  );
}

/**
 * The folders pinned to the top of the drive.
 *
 * `projects` leads them, because the product is one computer and a project is a
 * folder in it: the drive's first tile should be the thing the rest of the
 * product is organized by. The others are separate volumes under the hood
 * (mounted elsewhere in the sandbox) but a member has no reason to know that —
 * here they are just the folders chat and agents fill.
 *
 * Their labels are reserved at the drive root (`SYSTEM_FOLDER_NAMES`): a
 * hand-made folder with one of those names would land in this same row under
 * the same label but point at a different volume.
 */
function SystemFolders({ onOpenDir }: { onOpenDir: (path: string) => void }) {
  const t = useT();
  const publicSets = useOrgFsPublicSets();
  const setCount = publicSets.data?.length ?? 0;
  const projectsPath = `${HOME_MOUNT_PATH}/${PROJECTS_FOLDER}`;
  return (
    <>
      <FolderTile
        name={PROJECTS_FOLDER}
        glyph={Folder}
        tone="system"
        counts={{
          volume: HOME_MOUNT_PATH,
          path: PROJECTS_FOLDER,
          enabled: true,
        }}
        onOpen={() => onOpenDir(projectsPath)}
      />
      {SYSTEM_FOLDERS.map((f) => (
        <VolumeFolderTile
          key={f.volume}
          volume={f.volume}
          glyph={f.glyph}
          onOpen={() => onOpenDir(f.volume)}
        />
      ))}
      {setCount > 0 && (
        <FolderTile
          name={segmentLabel("public")}
          meta={t("library.libraryViews.skillSetsCount", { count: setCount })}
          glyph={Zap}
          tone="system"
          readOnly
          onOpen={() => onOpenDir("public")}
        />
      )}
      <SyncedRepoFolders onOpenDir={onOpenDir} />
    </>
  );
}

/**
 * The project each folder under `projects/` belongs to, by folder name.
 *
 * Read non-blocking and allowed to be empty: the avatar it resolves is
 * decoration on a tile that is already correct without it, and a listing must
 * not wait on the project list to draw a folder.
 */
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
    matchesLibraryFileView(entry.path, view.fileView),
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
        count={results.length}
        typeLabel={t("library.entries.location")}
      >
        {sorted.map(({ item, hit: e }) => {
          // Hits from the shared public sets are read-only: no share/delete.
          const readOnly = publicSetOf(e.volume) !== null;
          const downloadUrl = fileUrl(e.volume, e.path);
          return (
            <FileEntry
              key={`${e.volume}/${e.path}`}
              entry={item}
              view={view}
              secondary={locationOf(e.volume, e.path, org.slug)}
              publicState={publicStateOf(e)}
              downloadUrl={downloadUrl}
              actions={{
                onOpen: () => onOpenFile(browsePathForEntry(e.volume, e.path)),
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

/**
 * Cross-volume "Recently added" feed. Sits at the BOTTOM of the drive listing
 * (folders first — that's what people came for) and only there: it spans every
 * volume, so it would be a lie inside any single folder.
 */
function RecentlyAdded({
  view,
  onOpenFile,
  onShare,
  onDelete,
}: {
  view: ListingView;
  onOpenFile: (previewPath: string) => void;
  onShare: (target: ShareTarget) => void;
  onDelete: (pending: PendingDelete) => void;
}) {
  const t = useT();
  const { org } = useProjectContext();
  const recent = useOrgFsRecent();
  const fileUrl = useOrgFsFileUrl();

  const shareFile = (e: OrgFsEntry & { volume: string }) =>
    onShare({
      volume: e.volume,
      path: e.path,
      kind: "file",
      shareMode: e.shareMode ?? "private",
      effectivePublic: e.effectivePublic ?? false,
      url: publicFileUrl(fileUrl(e.volume, e.path)),
    });

  if (recent.isPending) return <ListSkeleton rows={4} />;
  const recentlyAdded = (recent.data ?? [])
    .filter((entry) => matchesLibraryFileView(entry.path, view.fileView))
    .slice(0, RECENTLY_ADDED_COUNT);
  if (recentlyAdded.length === 0) return null;

  return (
    /* Already in recency order from the server, and that IS the section — the
       sort control would rename it after an order it no longer has, so this one
       list does not take one. */
    <FilesSection
      view={view}
      label={t("library.libraryViews.recentlyAdded")}
      typeLabel={t("library.entries.location")}
    >
      {recentlyAdded.map((e) => {
        const item = toLibraryEntry(e);
        const downloadUrl = fileUrl(e.volume, e.path);
        return (
          <FileEntry
            key={`${e.volume}/${e.path}`}
            entry={item}
            view={view}
            secondary={locationOf(e.volume, e.path, org.slug)}
            publicState={publicStateOf(e)}
            downloadUrl={downloadUrl}
            actions={{
              onOpen: () => onOpenFile(browsePathForEntry(e.volume, e.path)),
              download: { url: downloadUrl, filename: item.name },
              onShare: () => shareFile(e),
              onDelete: () =>
                onDelete({ volume: e.volume, path: e.path, kind: "file" }),
            }}
          />
        );
      })}
    </FilesSection>
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
}) {
  const t = useT();
  const { org } = useProjectContext();
  const volume = location.volume ?? "";
  const listing = useOrgFsList(volume, location.dirPath);
  const fileUrl = useOrgFsFileUrl();
  const projectsByFolder = useProjectsByFolder();
  const isDriveRoot = location.isHomeRoot && root === HOME_MOUNT_PATH;
  /** Inside `projects/`, a folder IS a project — so it wears the project's own
   *  avatar. The one place in the drive where a folder has an identity beyond
   *  its name, and the place that teaches the whole metaphor. */
  const inProjectsFolder =
    volume === HOME_MOUNT_PATH && location.dirPath === PROJECTS_FOLDER;

  /** A folder named `uploads` that predates the pinned tiles still renders, so
   *  it carries its path to tell it from the volume card. New collisions are
   *  rejected at the writers; these are the ones already out there. */
  const disambiguate = (name: string) =>
    isDriveRoot && SYSTEM_FOLDER_NAMES.has(name.toLowerCase())
      ? `${homeDisplayName(org.slug)}/${name}`
      : undefined;

  // The pinned folders don't depend on this listing, so they render straight
  // away on the landing view instead of flashing a skeleton.
  const systemFolders = isDriveRoot ? (
    <SystemFolders onOpenDir={onOpenDir} />
  ) : null;

  if (listing.isPending) {
    return (
      <>
        {systemFolders && (
          <Section label={t("library.libraryViews.folders")}>
            <FolderTiles>{systemFolders}</FolderTiles>
          </Section>
        )}
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

  // An empty root still has the pinned folders and the recent feed to show.
  if (entries.length === 0 && !isDriveRoot) {
    return (
      <EmptyNote>
        {location.readOnly
          ? t("library.libraryViews.emptyReadOnlySet")
          : t("library.libraryViews.emptyFolder")}
      </EmptyNote>
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

  const skills = entries.filter((e) => e.kind === "dir" && e.hasSkill);
  // Skill wins over brand if a dir somehow carries both markers.
  const brands = entries.filter(
    (e) => e.kind === "dir" && e.hasBrand && !e.hasSkill,
  );
  const dirs = entries.filter(
    (e) => e.kind === "dir" && !e.hasSkill && !e.hasBrand,
  );
  const files = entries.filter(
    (e) => e.kind === "file" && matchesLibraryFileView(e.path, view.fileView),
  );
  const sortedFiles = sortEntries(files.map(toLibraryEntry), view.sort);

  return (
    <>
      {(dirs.length > 0 || systemFolders) && (
        <Section
          label={t("library.libraryViews.folders")}
          /* Only where it is the whole truth. At the drive root the pinned
             folders are drawn beside these and are not in this listing, so a
             count here would name a number nobody can find on screen. */
          count={systemFolders ? undefined : dirs.length}
        >
          <FolderTiles>
            {systemFolders}
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
      {skills.length > 0 && (
        <Section label={t("library.libraryViews.skills")} count={skills.length}>
          <CardsGrid>
            {skills.map((e) => (
              <SkillCard
                key={e.path}
                dirName={basename(e.path)}
                updatedAt={e.updatedAt}
                skillMdUrl={fileUrl(volume, `${e.path}/SKILL.md`)}
                publicState={publicStateOf(e)}
                onOpen={() => onOpenSkill(browsePathFor(location, e.path))}
                onBrowse={() => onOpenDir(browsePathFor(location, e.path))}
                onShare={shareFor(e)}
                onDelete={deleteFor(e)}
                draggable={!location.readOnly}
                {...makeDragHandlers(e.path, "dir", {
                  onDragStart,
                  onContextMenu,
                })}
              />
            ))}
          </CardsGrid>
        </Section>
      )}
      {brands.length > 0 && (
        <Section label={t("library.libraryViews.brands")} count={brands.length}>
          <CardsGrid>
            {brands.map((e) => (
              <BrandCard
                key={e.path}
                dirName={basename(e.path)}
                updatedAt={e.updatedAt}
                tokensUrl={fileUrl(volume, `${e.path}/tokens.css`)}
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
          </CardsGrid>
        </Section>
      )}
      {sortedFiles.length > 0 && (
        <FilesSection
          view={view}
          count={sortedFiles.length}
          typeLabel={t("library.library.type")}
        >
          {sortedFiles.map((item) => (
            <FileEntry
              key={item.path}
              entry={item}
              view={view}
              publicState={publicStateOf(item.entry)}
              downloadUrl={fileUrl(volume, item.path)}
              actions={{
                onOpen: () => onOpenFile(browsePathFor(location, item.path)),
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
      {view.fileView !== "all" && files.length === 0 && (
        <EmptyNote>{t("library.library.noFilesInView")}</EmptyNote>
      )}
      {isDriveRoot && (
        <RecentlyAdded
          view={view}
          onOpenFile={onOpenFile}
          onShare={onShare}
          onDelete={onDelete}
        />
      )}
    </>
  );
}
