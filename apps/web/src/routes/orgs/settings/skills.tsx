/**
 * Settings → Build → Skills: an org-wide view of every skill available to the
 * org's agents (the same catalog `<available-skills>` surfaces at runtime),
 * plus importing new ones.
 *
 * The grid scrolls a page at a time (`useOrgFsSkillCatalogPages`): the search
 * box, the origin chips and the alphabetical sort are all server-side, so only
 * the cards on screen are ever on the wire.
 *
 * Skills are just `SKILL.md` folders on the org filesystem, so importing one is
 * the Library's upload with the skill format enforced: pick a folder containing
 * a `SKILL.md` and its files land under `home/skills/<slug>/…`, subdirectories
 * intact. Public sets and synced-repo skills are read-only.
 */

import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertTriangle,
  DotsVertical,
  GitBranch01,
  Package,
  Trash01,
  Upload01,
  Zap,
} from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";
import { Card } from "@decocms/ui/components/card.tsx";
import { SearchInput } from "@decocms/ui/components/search-input.tsx";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@decocms/ui/components/dropdown-menu.tsx";
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
import { Page } from "@/components/page";
import { EmptyState } from "@/components/empty-state.tsx";
import { CollectionTabs } from "@/components/collections/collection-tabs.tsx";
import { FolderIcon } from "@/components/folder-icon";
import { useProjectContext } from "@/sdk";
import { useT } from "@/i18n/use-t.ts";
import { KEYS } from "@/lib/query-keys";
import {
  fetchOrgFsStat,
  type OrgFsSkillCatalogEntry,
  useOrgFsMutations,
  useOrgFsSkillCatalogPages,
} from "@/hooks/use-org-fs";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useInfiniteScroll } from "@/hooks/use-infinite-scroll";
import { browsePathForEntry } from "@/layouts/library/location";
import { SkillPreviewDialog } from "@/layouts/library/skill-preview";
import {
  groupByDestination,
  importable,
  MAX_IMPORT_FILES,
  relativePath,
  slugify,
  uploadAllGroups,
} from "./skills-import.ts";

/** Filter-chip id for "no origin filter". Not a real `source`, so it can't
 *  collide with one. */
const ALL_SOURCES = "*";

/** Home-volume skills are the org's own — editable. Everything else (public
 *  sets, synced repos) is read-only here, same as in the Library. */
function isEditable(entry: OrgFsSkillCatalogEntry): boolean {
  return entry.volume === "home";
}

/**
 * Where a skill comes from — the one axis that actually varies across the
 * catalog, so it names the filter chips and marks the folder body.
 *
 * The catalog's raw `source` is a wire token (`home`, `public:core`,
 * `repo:docs`) which doubles as a stable filter id, but a member has no reason
 * to read it: the prefix is dropped and `home` resolves to the org's own name.
 */
function skillOrigin(source: string, orgName: string) {
  const separator = source.indexOf(":");
  if (separator === -1) return { label: orgName, glyph: Zap };
  return {
    label: source.slice(separator + 1),
    glyph: source.startsWith("repo:") ? GitBranch01 : Package,
  };
}

/**
 * One skill, wearing the Library's folder: same icon a member already
 * associates with these directories, and the same palette rule — Finder blue
 * for folders people make, graphite plus a view-only badge for the ones the
 * product fills. The body glyph names the origin (set, repo, your own).
 */
function SkillCard({
  entry,
  onOpen,
  onDelete,
}: {
  entry: OrgFsSkillCatalogEntry;
  onOpen: () => void;
  onDelete?: () => void;
}) {
  const t = useT();
  const { org } = useProjectContext();
  const { label, glyph } = skillOrigin(entry.source, org.name);
  // The predicate that gates delete, so the badge can't contradict the menu.
  const editable = isEditable(entry);

  return (
    <Card className="relative transition-colors group overflow-hidden flex flex-col h-full hover:bg-muted/50">
      {/* Overlay button — the whole card opens the preview */}
      <button
        type="button"
        onClick={onOpen}
        className="absolute inset-0 z-0"
        aria-label={entry.name}
      />

      {/* pointer-events-none lets clicks fall through to the overlay button */}
      <div className="flex flex-col flex-1 pointer-events-none">
        <div className="flex flex-col gap-3 p-4.5">
          <div className="flex items-start justify-between">
            <FolderIcon
              glyph={glyph}
              tone={editable ? "default" : "system"}
              readOnly={!editable}
              className="size-8 shrink-0"
            />
            {onDelete && (
              /* pointer-events-auto re-enables the dropdown */
              <div className="relative z-10 pointer-events-auto transition-opacity sm:opacity-0 sm:group-hover:opacity-100">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
                      <DotsVertical size={16} />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      variant="destructive"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDelete();
                      }}
                    >
                      <Trash01 size={16} />
                      {t("settings.skills.deleteButton")}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            )}
          </div>

          <div className="flex flex-col gap-1">
            <h3 className="text-sm font-medium text-foreground truncate">
              {entry.name}
            </h3>
            <p className="text-sm text-muted-foreground line-clamp-2">
              {entry.description || t("settings.skills.noDescription")}
            </p>
          </div>
        </div>

        <div className="border-t border-border mt-auto">
          <div className="h-10 flex items-center px-4.5">
            <p className="text-xs text-muted-foreground truncate">{label}</p>
          </div>
        </div>
      </div>
    </Card>
  );
}

function SkillsGrid({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 @lg:grid-cols-2 @4xl:grid-cols-3 @6xl:grid-cols-4 gap-4">
      {children}
    </div>
  );
}

export default function SettingsSkillsPage() {
  const t = useT();
  const { org } = useProjectContext();
  const { remove, upload } = useOrgFsMutations("home");
  const queryClient = useQueryClient();
  const folderInputRef = useRef<HTMLInputElement>(null);

  const [search, setSearch] = useState("");
  const [source, setSource] = useState(ALL_SOURCES);
  const [importing, setImporting] = useState(false);
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] =
    useState<OrgFsSkillCatalogEntry | null>(null);

  // Searching and filtering happen server-side now, so every keystroke would
  // otherwise be a catalog rescan.
  const debouncedSearch = useDebouncedValue(search, 250);
  const catalog = useOrgFsSkillCatalogPages({
    search: debouncedSearch,
    source: source === ALL_SOURCES ? undefined : source,
  });

  const refreshCatalog = () => {
    queryClient.invalidateQueries({ queryKey: KEYS.slashSkills(org.id) });
    queryClient.invalidateQueries({ queryKey: KEYS.orgFsSkills(org.id) });
    queryClient.invalidateQueries({
      queryKey: KEYS.orgFsSkillPagesRoot(org.id),
    });
  };

  async function handleImport(fileList: FileList | null) {
    const picked = [...(fileList ?? [])];
    // Reset first: picking the same folder twice must re-fire `change`.
    if (folderInputRef.current) folderInputRef.current.value = "";
    if (picked.length === 0) return;

    // Empty means the browser ignored `webkitdirectory` and gave a flat pick,
    // which would flatten the skill's subdirectories onto its root.
    const root = picked[0]?.webkitRelativePath ?? "";
    if (!root) {
      toast.error(t("settings.skills.importNeedsFolder"));
      return;
    }

    const folder = root.split("/")[0] ?? "";
    const files = picked.filter(importable);
    if (!files.some((f) => relativePath(f) === "SKILL.md")) {
      toast.error(t("settings.skills.importMissingSkillMd"));
      return;
    }
    if (files.length > MAX_IMPORT_FILES) {
      toast.error(
        t("settings.skills.importTooManyFiles", {
          count: String(files.length),
          max: String(MAX_IMPORT_FILES),
        }),
      );
      return;
    }

    const slug = slugify(folder);
    const dir = `skills/${slug}`;
    // Only true once the probe below proved the tree ours to roll back.
    let created = false;
    setImporting(true);
    try {
      // Merging would leave the existing skill's unmatched files behind.
      if (await fetchOrgFsStat(org.slug, "home", dir)) {
        toast.error(t("settings.skills.importSlugTaken", { slug }));
        return;
      }
      created = true;
      await uploadAllGroups(
        groupByDestination(files, slug),
        upload.mutateAsync,
      );
      refreshCatalog();
      toast.success(t("settings.skills.importSuccess", { name: slug }));
    } catch (err) {
      // A half-written tree would serve agents a broken skill, and its bare
      // directory would block the retry on the slug probe above.
      if (created) await remove.mutateAsync(dir).catch(() => {});
      refreshCatalog();
      toast.error(
        err instanceof Error ? err.message : t("settings.skills.importError"),
      );
    } finally {
      setImporting(false);
    }
  }

  // Already searched, source-filtered and alphabetized by the server; pages
  // concatenate in cursor order, so the grid stays alphabetical as it grows.
  const loaded = catalog.data?.pages.flatMap((p) => p.skills) ?? [];

  // Chips ride along on every page and are identical across them (they cover
  // the whole catalog, not the page), so the first page is as good as any.
  const sources = catalog.data?.pages[0]?.sources ?? [];
  const tabs = [
    {
      id: ALL_SOURCES,
      label: t("settings.skills.filterAll"),
      count: sources.reduce((sum, s) => sum + s.count, 0),
    },
    ...sources.map(({ source: entrySource, count }) => ({
      id: entrySource,
      label: skillOrigin(entrySource, org.name).label,
      count,
    })),
  ];

  const loadMoreRef = useInfiniteScroll(
    () => void catalog.fetchNextPage(),
    catalog.hasNextPage,
    // `isFetching`, not `isFetchingNextPage`: while a filter change is in
    // flight the grid still shows the previous filter's pages, and its cursor
    // does not address the new query.
    catalog.isFetching,
  );

  // A source can vanish under the filter (deleting its last skill), which would
  // strand the grid empty on a chip that is no longer rendered. `sources` spans
  // the whole catalog, so its absence there is proof — snap back to All.
  if (
    source !== ALL_SOURCES &&
    sources.length > 0 &&
    !sources.some((s) => s.source === source)
  ) {
    setSource(ALL_SOURCES);
  }

  const openPreview = (entry: OrgFsSkillCatalogEntry) =>
    setPreviewPath(browsePathForEntry(entry.volume, entry.path));

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    const { path } = pendingDelete;
    setPendingDelete(null);
    try {
      await remove.mutateAsync(path);
      refreshCatalog();
      toast.success(t("settings.skills.deleteSuccess"));
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t("settings.skills.deleteError"),
      );
    }
  };

  const importButton = (
    <Button
      size="sm"
      disabled={importing}
      onClick={() => folderInputRef.current?.click()}
    >
      <Upload01 size={14} />
      {importing
        ? t("settings.skills.importing")
        : t("settings.skills.importButton")}
    </Button>
  );

  return (
    <Page>
      <Page.Content>
        <Page.Body>
          {/* Title, toolbar, chips and results are siblings of one gap-6
              column — the Connections page's rhythm. */}
          <div className="flex flex-col gap-6">
            <Page.Title>{t("settings.skills.pageTitle")}</Page.Title>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <SearchInput
                value={search}
                onChange={setSearch}
                placeholder={t("settings.skills.searchPlaceholder")}
                className="w-full md:w-[375px]"
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    setSearch("");
                    (event.target as HTMLInputElement).blur();
                  }
                }}
              />
              {importButton}
              <input
                ref={folderInputRef}
                type="file"
                multiple
                webkitdirectory=""
                className="hidden"
                onChange={(e) => void handleImport(e.target.files)}
              />
            </div>

            {/* One origin means the chips can only say "All" — hide them. */}
            {tabs.length > 2 && (
              <CollectionTabs
                tabs={tabs}
                activeTab={source}
                onTabChange={setSource}
              />
            )}

            {catalog.isPending ? (
              <div className="@container">
                <SkillsGrid>
                  {Array.from({ length: 8 }, (_, i) => (
                    <Skeleton key={i} className="h-[168px] rounded-xl" />
                  ))}
                </SkillsGrid>
              </div>
            ) : catalog.isError ? (
              /* Never the empty state: "no skills yet" is a different fact. */
              <div className="flex items-center justify-center py-20">
                <EmptyState
                  image={
                    <AlertTriangle
                      size={48}
                      className="text-muted-foreground"
                    />
                  }
                  title={t("settings.skills.errorTitle")}
                  description={
                    catalog.error instanceof Error
                      ? catalog.error.message
                      : t("settings.skills.errorDescription")
                  }
                  actions={
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void catalog.refetch()}
                    >
                      {t("settings.skills.retry")}
                    </Button>
                  }
                />
              </div>
            ) : loaded.length === 0 ? (
              /* Keyed off the search that was actually queried, so the copy
                 can't claim "no results for X" while X is still debouncing. */
              <div className="flex items-center justify-center py-20">
                <EmptyState
                  image={<Zap size={48} className="text-muted-foreground" />}
                  title={
                    debouncedSearch
                      ? t("settings.skills.noResultsTitle")
                      : t("settings.skills.emptyTitle")
                  }
                  description={
                    debouncedSearch
                      ? t("settings.skills.noResultsDescription", {
                          search: debouncedSearch,
                        })
                      : t("settings.skills.emptyDescription")
                  }
                  actions={!debouncedSearch && importButton}
                />
              </div>
            ) : (
              <div className="@container">
                <SkillsGrid>
                  {loaded.map((entry) => (
                    <SkillCard
                      key={entry.id}
                      entry={entry}
                      onOpen={() => openPreview(entry)}
                      onDelete={
                        isEditable(entry)
                          ? () => setPendingDelete(entry)
                          : undefined
                      }
                    />
                  ))}
                  {catalog.isFetchingNextPage &&
                    Array.from({ length: 4 }, (_, i) => (
                      <Skeleton key={i} className="h-[168px] rounded-xl" />
                    ))}
                </SkillsGrid>
                {/* Sentinel sits after the last card. Left on the default
                    viewport root — `Page.Content` is the actual scroller, but
                    IntersectionObserver already accounts for its clipping. */}
                <div ref={loadMoreRef} aria-hidden className="h-px" />
              </div>
            )}
          </div>
        </Page.Body>
      </Page.Content>

      {previewPath && (
        <SkillPreviewDialog
          key={previewPath}
          skillPath={previewPath}
          onClose={() => setPreviewPath(null)}
        />
      )}

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("settings.skills.deleteDialogTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings.skills.deleteDialogDescription", {
                name: pendingDelete?.name ?? "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("settings.skills.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t("settings.skills.deleteButton")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Page>
  );
}
