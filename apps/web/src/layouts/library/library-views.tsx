import type { ComponentType, SVGProps } from "react";
import { useProjectContext } from "@/sdk";
import { ChevronRight, Stars01, Upload01, Zap } from "@untitledui/icons";
import { cn } from "@decocms/ui/lib/utils.ts";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import {
  HOME_MOUNT_PATH,
  homeDisplayName,
} from "@decocms/shared/organization/home-mount";
import { useT } from "@/i18n/use-t.ts";
import type { TranslationKey } from "@/i18n/en/index.ts";
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
  FolderCard,
  type PublicState,
  RecentFileCard,
  SkillCard,
  timeAgo,
} from "./cards";
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
 *  home root. Lowercased — "Uploads" reads as the same folder to a human. */
export const SYSTEM_FOLDER_NAMES: ReadonlySet<string> = new Set([
  ...SYSTEM_FOLDERS.map((f) => f.volume),
  segmentLabel("public"),
]);

const RECENTLY_ADDED_COUNT = 6;

/** "volume/dir" a cross-volume entry lives in — home shows the org slug,
 *  `public-<set>` volumes show as `public/<set>`. */
function locationOf(volume: string, path: string, orgSlug: string): string {
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  const set = publicSetOf(volume);
  const volLabel = set
    ? `public/${set}`
    : volume === "home"
      ? homeDisplayName(orgSlug)
      : volume;
  return dir ? `${volLabel}/${dir}` : volLabel;
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

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="text-[13px] text-foreground">{children}</p>;
}

function CardsGrid({ children }: { children: React.ReactNode }) {
  return (
    <div className="@container">
      <div className="grid grid-cols-1 gap-3 @[440px]:grid-cols-2 @[660px]:grid-cols-3">
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
  descriptionKey,
  glyph,
  onOpen,
}: {
  volume: string;
  descriptionKey: TranslationKey;
  glyph?: ComponentType<SVGProps<SVGSVGElement>>;
  onOpen: () => void;
}) {
  const t = useT();
  const usage = useOrgFsUsage(volume);
  return (
    <FolderCard
      name={volume}
      meta={
        usage.data
          ? t("library.libraryViews.filesCount", { count: usage.data.files })
          : undefined
      }
      subtitle={t(descriptionKey)}
      glyph={glyph}
      tone="system"
      onOpen={onOpen}
    />
  );
}

/**
 * The system folders, rendered first inside the home listing. They're separate
 * volumes under the hood (mounted elsewhere in the sandbox) but a member has no
 * reason to know that — here they're just the folders chat and agents fill.
 *
 * Their labels (`uploads`, `outputs`, and `public` presenting as "skills") are
 * therefore reserved at the home root: a hand-made folder with one of those
 * names would land in this same grid under the same label but point at a
 * different volume. `SYSTEM_FOLDER_NAMES` is what the writers check.
 */
function SystemFolders({ onOpenDir }: { onOpenDir: (path: string) => void }) {
  const t = useT();
  const publicSets = useOrgFsPublicSets();
  const setCount = publicSets.data?.length ?? 0;
  return (
    <>
      {SYSTEM_FOLDERS.map((f) => (
        <VolumeFolderCard
          key={f.volume}
          volume={f.volume}
          descriptionKey={f.descriptionKey}
          glyph={f.glyph}
          onOpen={() => onOpenDir(f.volume)}
        />
      ))}
      {setCount > 0 && (
        <FolderCard
          name={segmentLabel("public")}
          meta={t("library.libraryViews.skillSetsCount", { count: setCount })}
          subtitle={t("library.libraryViews.curatedSkillSetsReadOnly")}
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
 * Location trail — the only place the current folder is named (there's no page
 * heading duplicating it). The org's home volume IS the top of the tree, so its
 * segment folds into the root crumb, which is labelled with the org itself; the
 * sibling volumes (uploads/outputs/public) hang off that crumb.
 */
export function Breadcrumbs({
  segments,
  onNavigate,
}: {
  segments: string[];
  onNavigate: (path: string) => void;
}) {
  const { org } = useProjectContext();
  const rest = segments[0] === HOME_MOUNT_PATH ? segments.slice(1) : segments;
  const offset = segments.length - rest.length;
  const atRoot = rest.length === 0;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1 text-sm">
      {atRoot ? (
        <span className="truncate font-medium text-foreground">
          {homeDisplayName(org.slug)}
        </span>
      ) : (
        <button
          type="button"
          className="truncate text-muted-foreground hover:text-foreground hover:underline"
          onClick={() => onNavigate(HOME_MOUNT_PATH)}
        >
          {homeDisplayName(org.slug)}
        </button>
      )}
      {rest.map((seg, i) => {
        const prefix = segments.slice(0, offset + i + 1).join("/");
        const isLast = i === rest.length - 1;
        return (
          <span key={prefix} className="flex min-w-0 items-center gap-1">
            <ChevronRight
              size={12}
              className="shrink-0 text-muted-foreground"
            />
            {isLast ? (
              <span className="truncate font-medium text-foreground">
                {segmentLabel(seg)}
              </span>
            ) : (
              <button
                type="button"
                className="truncate text-muted-foreground hover:text-foreground hover:underline"
                onClick={() => onNavigate(prefix)}
              >
                {segmentLabel(seg)}
              </button>
            )}
          </span>
        );
      })}
    </div>
  );
}

/**
 * Search results, shown in place of whatever listing is active while the search
 * box has a query. Cross-volume at the home root, narrowed to the current
 * folder's subtree everywhere else (`scope`) — so the placeholder's promise
 * ("Search files in decks") is what actually happens.
 */
export function SearchResultsView({
  query,
  scope,
  stale,
  onOpenFile,
  onShare,
  onDelete,
}: {
  query: string;
  /** Narrow to one volume + directory subtree; unset = cross-volume. */
  scope?: OrgFsSearchScope;
  /** The input is ahead of `query` (still inside the debounce window). */
  stale: boolean;
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

  if (search.isPending) return <GridSkeleton rows={2} />;
  const results = search.data ?? [];
  if (results.length === 0) {
    return (
      <EmptyNote>{t("library.libraryViews.noFilesMatch", { query })}</EmptyNote>
    );
  }
  return (
    <div
      className={cn(
        "flex flex-col gap-3",
        // Dim while showing results for a previous query.
        (stale || search.isPlaceholderData) && "opacity-50",
      )}
    >
      <SectionLabel>
        {t("library.libraryViews.searchResults", { count: results.length })}
      </SectionLabel>
      <CardsGrid>
        {results.map((e) => {
          // Hits from the shared public sets are read-only: no share/delete.
          const readOnly = publicSetOf(e.volume) !== null;
          return (
            <FileCard
              key={`${e.volume}/${e.path}`}
              filename={basename(e.path)}
              updatedAt={e.updatedAt}
              downloadUrl={fileUrl(e.volume, e.path)}
              subtitle={locationOf(e.volume, e.path, org.slug)}
              publicState={publicStateOf(e)}
              onOpen={() => onOpenFile(browsePathForEntry(e.volume, e.path))}
              onShare={readOnly ? undefined : () => shareFile(e)}
              onDelete={
                readOnly
                  ? undefined
                  : () =>
                      onDelete({ volume: e.volume, path: e.path, kind: "file" })
              }
            />
          );
        })}
      </CardsGrid>
    </div>
  );
}

/**
 * Cross-volume "Recently added" feed. Sits at the BOTTOM of the home listing
 * (folders first — that's what people came for) and only there: it spans every
 * volume, so it would be a lie inside any single folder.
 */
function RecentlyAdded({
  onOpenFile,
  onShare,
  onDelete,
}: {
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

  if (recent.isPending) {
    return (
      <div className="flex flex-col gap-3">
        <SectionLabel>{t("library.libraryViews.recentlyAdded")}</SectionLabel>
        <GridSkeleton />
      </div>
    );
  }
  const recentlyAdded = (recent.data ?? []).slice(0, RECENTLY_ADDED_COUNT);
  if (recentlyAdded.length === 0) return null;

  return (
    <div className="flex flex-col gap-3">
      <SectionLabel>{t("library.libraryViews.recentlyAdded")}</SectionLabel>
      <CardsGrid>
        {recentlyAdded.map((e) => (
          <RecentFileCard
            key={`${e.volume}/${e.path}`}
            filename={basename(e.path)}
            updatedAt={e.updatedAt}
            size={e.size}
            downloadUrl={fileUrl(e.volume, e.path)}
            subtitle={locationOf(e.volume, e.path, org.slug)}
            publicState={publicStateOf(e)}
            onOpen={() => onOpenFile(browsePathForEntry(e.volume, e.path))}
            onShare={() => shareFile(e)}
            onDelete={() =>
              onDelete({ volume: e.volume, path: e.path, kind: "file" })
            }
          />
        ))}
      </CardsGrid>
    </div>
  );
}

/** Listing for `public` — one read-only folder per configured set. */
export function PublicSetsView({
  onOpenDir,
}: {
  onOpenDir: (path: string) => void;
}) {
  const t = useT();
  const publicSets = useOrgFsPublicSets();
  if (publicSets.isPending) return <GridSkeleton />;
  const sets = publicSets.data ?? [];
  if (sets.length === 0) {
    return (
      <EmptyNote>
        {t("library.libraryViews.noPublicSkillSetsConfigured")}
      </EmptyNote>
    );
  }
  return (
    <CardsGrid>
      {sets.map((set) => (
        <FolderCard
          key={set}
          name={set}
          subtitle={t("library.libraryViews.readOnly")}
          readOnly
          onOpen={() => onOpenDir(`public/${set}`)}
        />
      ))}
    </CardsGrid>
  );
}

/**
 * Listing of one directory inside a volume — and, at the home root, the
 * Library's landing view: the system folders lead the folder grid and the
 * cross-volume "Recently added" feed closes the page.
 */
export function VolumeView({
  location,
  onOpenDir,
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
  onOpenDir: (path: string) => void;
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

  // A folder that predates the system-folder cards (or that an agent wrote)
  // can already be named `uploads`/`outputs`/`skills`. Both cards render — the
  // real one still opens and renames normally — but two cards under one label
  // is a lie, so the home-volume one carries its path to tell them apart.
  // New collisions are rejected at the writers; this is for the ones already
  // out there, which we won't rename behind the org's back.
  const disambiguate = (name: string) =>
    location.isHomeRoot && SYSTEM_FOLDER_NAMES.has(name.toLowerCase())
      ? `${homeDisplayName(org.slug)}/${name}`
      : undefined;

  // The system folders don't depend on this listing, so they render straight
  // away on the landing view instead of flashing a skeleton.
  const systemFolders = location.isHomeRoot ? (
    <SystemFolders onOpenDir={onOpenDir} />
  ) : null;

  if (listing.isPending) {
    return (
      <>
        {systemFolders && (
          <div className="flex flex-col gap-3">
            <SectionLabel>{t("library.libraryViews.folders")}</SectionLabel>
            <CardsGrid>{systemFolders}</CardsGrid>
          </div>
        )}
        <GridSkeleton rows={2} />
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

  const entries = listing.data ?? [];
  const skills = entries.filter((e) => e.kind === "dir" && e.hasSkill);
  // Skill wins over brand if a dir somehow carries both markers.
  const brands = entries.filter(
    (e) => e.kind === "dir" && e.hasBrand && !e.hasSkill,
  );
  const dirs = entries.filter(
    (e) => e.kind === "dir" && !e.hasSkill && !e.hasBrand,
  );
  const files = entries.filter((e) => e.kind === "file");

  // An empty home root still has the system folders and the recent feed to show.
  if (entries.length === 0 && !location.isHomeRoot) {
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

  return (
    <>
      {skills.length > 0 && (
        <div className="flex flex-col gap-3">
          <SectionLabel>{t("library.libraryViews.skills")}</SectionLabel>
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
        </div>
      )}
      {brands.length > 0 && (
        <div className="flex flex-col gap-3">
          <SectionLabel>{t("library.libraryViews.brands")}</SectionLabel>
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
        </div>
      )}
      {(dirs.length > 0 || systemFolders) && (
        <div className="flex flex-col gap-3">
          <SectionLabel>{t("library.libraryViews.folders")}</SectionLabel>
          <CardsGrid>
            {systemFolders}
            {dirs.map((e) => (
              <FolderCard
                key={e.path}
                name={basename(e.path)}
                meta={timeAgo(e.updatedAt)}
                subtitle={disambiguate(basename(e.path))}
                readOnly={location.readOnly}
                publicState={publicStateOf(e)}
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
            ))}
          </CardsGrid>
        </div>
      )}
      {files.length > 0 && (
        <div className="flex flex-col gap-3">
          <SectionLabel>{t("library.libraryViews.files")}</SectionLabel>
          <CardsGrid>
            {files.map((e) => (
              <FileCard
                key={e.path}
                filename={basename(e.path)}
                updatedAt={e.updatedAt}
                downloadUrl={fileUrl(volume, e.path)}
                publicState={publicStateOf(e)}
                onOpen={() => onOpenFile(browsePathFor(location, e.path))}
                onShare={shareFor(e)}
                onDelete={deleteFor(e)}
                draggable={!location.readOnly}
                {...makeDragHandlers(e.path, "file", {
                  onDragStart,
                  onContextMenu,
                })}
              />
            ))}
          </CardsGrid>
        </div>
      )}
      {location.isHomeRoot && (
        <RecentlyAdded
          onOpenFile={onOpenFile}
          onShare={onShare}
          onDelete={onDelete}
        />
      )}
    </>
  );
}
