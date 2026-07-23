import type { ComponentType, SVGProps } from "react";
import { useProjectContext } from "@decocms/mesh-sdk";
import {
  ChevronRight,
  Globe01,
  Home01,
  Stars01,
  Upload01,
} from "@untitledui/icons";
import { cn } from "@deco/ui/lib/utils.ts";
import { Skeleton } from "@deco/ui/components/skeleton.tsx";
import { homeDisplayName } from "@/file-storage/home-mount";
import { useT } from "@/web/i18n/use-t.ts";
import {
  type OrgFsEntry,
  type ShareMode,
  useOrgFsFileUrl,
  useOrgFsList,
  useOrgFsPublicSets,
  useOrgFsRecent,
  useOrgFsSearch,
  useOrgFsUsage,
} from "@/web/hooks/use-org-fs";
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
} from "./location";
import type { ShareTarget } from "./file-share-button";

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

/** The volumes every sandbox mounts (see file-storage/mount/provisioning.ts).
 *  `glyph` marks the folder body, Finder-special-folder style. Skills are
 *  deliberately absent — they live in versioned repos (public sets), not as
 *  an editable cloud volume. */
export const VOLUMES = [
  {
    id: "home",
    descriptionKey: "library.libraryViews.volumeHomeDescription" as const,
    glyph: Home01,
  },
  {
    id: "uploads",
    descriptionKey: "library.libraryViews.volumeUploadsDescription" as const,
    glyph: Upload01,
  },
  {
    id: "outputs",
    descriptionKey: "library.libraryViews.volumeOutputsDescription" as const,
    glyph: Stars01,
  },
] as const;

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
  displayName,
  descriptionKey,
  glyph,
  onOpen,
}: {
  volume: string;
  /** Card label when it differs from the volume id (home shows the slug). */
  displayName?: string;
  descriptionKey: string;
  glyph?: ComponentType<SVGProps<SVGSVGElement>>;
  onOpen: () => void;
}) {
  const t = useT();
  const usage = useOrgFsUsage(volume);
  return (
    <FolderCard
      name={displayName ?? volume}
      meta={
        usage.data
          ? t("library.libraryViews.filesCount", { count: usage.data.files })
          : undefined
      }
      subtitle={t(descriptionKey as any)}
      glyph={glyph}
      onOpen={onOpen}
    />
  );
}

export function Breadcrumbs({
  segments,
  onNavigate,
}: {
  segments: string[];
  onNavigate: (path: string) => void;
}) {
  const t = useT();
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1 text-sm">
      <button
        type="button"
        className="text-muted-foreground hover:text-foreground hover:underline"
        onClick={() => onNavigate("")}
      >
        {t("library.libraryViews.library")}
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

/**
 * Global search results — cross-volume, shown in place of whatever listing
 * is active (root or folder) while the search box has a query.
 */
export function SearchResultsView({
  query,
  stale,
  onOpenFile,
  onShare,
  onDelete,
}: {
  query: string;
  /** The input is ahead of `query` (still inside the debounce window). */
  stale: boolean;
  onOpenFile: (previewPath: string) => void;
  onShare: (target: ShareTarget) => void;
  onDelete: (pending: PendingDelete) => void;
}) {
  const t = useT();
  const { org } = useProjectContext();
  const fileUrl = useOrgFsFileUrl();
  const search = useOrgFsSearch(query);

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

/** Root view: Recently added + Folders (volumes/public). */
export function RootView({
  onOpenDir,
  onOpenFile,
  onShare,
  onDelete,
}: {
  onOpenDir: (path: string) => void;
  onOpenFile: (previewPath: string) => void;
  onShare: (target: ShareTarget) => void;
  onDelete: (pending: PendingDelete) => void;
}) {
  const t = useT();
  const { org } = useProjectContext();
  const recent = useOrgFsRecent();
  const publicSets = useOrgFsPublicSets();
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

  const recentlyAdded = (recent.data ?? []).slice(0, RECENTLY_ADDED_COUNT);

  return (
    <>
      {recent.isPending ? (
        <div className="flex flex-col gap-3">
          <SectionLabel>{t("library.libraryViews.recentlyAdded")}</SectionLabel>
          <GridSkeleton />
        </div>
      ) : recentlyAdded.length > 0 ? (
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
                onOpen={() => onOpenFile(`${e.volume}/${e.path}`)}
                onShare={() => shareFile(e)}
                onDelete={() =>
                  onDelete({ volume: e.volume, path: e.path, kind: "file" })
                }
              />
            ))}
          </CardsGrid>
        </div>
      ) : (
        <EmptyNote>{t("library.libraryViews.noFilesYet")}</EmptyNote>
      )}

      <div className="flex flex-col gap-3">
        <SectionLabel>{t("library.libraryViews.folders")}</SectionLabel>
        <CardsGrid>
          {VOLUMES.map((v) => (
            <VolumeFolderCard
              key={v.id}
              volume={v.id}
              // The home volume presents as the org itself: its display label is
              // the org slug (with a reserved-slug fallback to "home" so two
              // cards aren't both named e.g. "public"). The agent-facing mount
              // path is always `org/home/` regardless of this label.
              displayName={
                v.id === "home" ? homeDisplayName(org.slug) : undefined
              }
              descriptionKey={v.descriptionKey}
              glyph={v.glyph}
              onOpen={() => onOpenDir(v.id)}
            />
          ))}
          {(publicSets.data?.length ?? 0) > 0 && (
            <FolderCard
              name="public"
              meta={t("library.libraryViews.skillSetsCount", {
                count: publicSets.data?.length ?? 0,
              })}
              subtitle={t("library.libraryViews.curatedSkillSetsReadOnly")}
              glyph={Globe01}
              readOnly
              onOpen={() => onOpenDir("public")}
            />
          )}
        </CardsGrid>
      </div>
    </>
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

/** Listing of one directory inside a volume. */
export function VolumeView({
  location,
  onOpenDir,
  onOpenFile,
  onOpenSkill,
  onOpenBrand,
  onShare,
  onDelete,
}: {
  location: LibraryLocation;
  onOpenDir: (path: string) => void;
  onOpenFile: (previewPath: string) => void;
  onOpenSkill: (skillPath: string) => void;
  onOpenBrand: (brandPath: string) => void;
  onShare: (target: ShareTarget) => void;
  onDelete: (pending: PendingDelete) => void;
}) {
  const t = useT();
  const volume = location.volume ?? "";
  const listing = useOrgFsList(volume, location.dirPath);
  const fileUrl = useOrgFsFileUrl();

  if (listing.isPending) return <GridSkeleton rows={2} />;
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

  if (entries.length === 0) {
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
              />
            ))}
          </CardsGrid>
        </div>
      )}
      {dirs.length > 0 && (
        <div className="flex flex-col gap-3">
          <SectionLabel>{t("library.libraryViews.folders")}</SectionLabel>
          <CardsGrid>
            {dirs.map((e) => (
              <FolderCard
                key={e.path}
                name={basename(e.path)}
                meta={timeAgo(e.updatedAt)}
                readOnly={location.readOnly}
                publicState={publicStateOf(e)}
                onOpen={() => onOpenDir(browsePathFor(location, e.path))}
                onShare={shareFor(e)}
                onDelete={deleteFor(e)}
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
              />
            ))}
          </CardsGrid>
        </div>
      )}
    </>
  );
}
