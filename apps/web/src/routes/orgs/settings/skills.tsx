/**
 * Settings → Build → Skills: an org-wide view of every skill available to the
 * org's agents (the same catalog `<available-skills>` surfaces at runtime —
 * see `useOrgFsSkillCatalog`), plus importing new ones.
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
import { cn } from "@decocms/ui/lib/utils.ts";
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
import { Main } from "@/components/main";
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
  useOrgFsSkillCatalog,
} from "@/hooks/use-org-fs";
import { browsePathForEntry } from "@/layouts/library/location";
import { SkillPreviewDialog } from "@/layouts/library/skill-preview";
import {
  groupByDestination,
  importable,
  MAX_IMPORT_FILES,
  optimisticEntry,
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
  pending,
  onOpen,
  onDelete,
}: {
  entry: OrgFsSkillCatalogEntry;
  /** Optimistic row whose files are still uploading — inert until they land. */
  pending?: boolean;
  onOpen: () => void;
  onDelete?: () => void;
}) {
  const t = useT();
  const { org } = useProjectContext();
  const { label, glyph } = skillOrigin(entry.source, org.name);
  // The predicate that gates delete, so the badge can't contradict the menu.
  const editable = isEditable(entry);

  return (
    <Card
      aria-busy={pending}
      className={cn(
        "relative transition-colors group overflow-hidden flex flex-col h-full",
        pending ? "opacity-60" : "hover:bg-muted/50",
      )}
    >
      {/* Overlay button — the whole card opens the preview. Absent while the
          upload is in flight: the preview's file reads cache a miss for a
          minute, so a card opened too early stays empty after the import
          succeeds. */}
      {!pending && (
        <button
          type="button"
          onClick={onOpen}
          className="absolute inset-0 z-0"
          aria-label={entry.name}
        />
      )}

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
              <div className="pointer-events-auto relative z-10 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 w-8 p-0"
                      aria-label={t("settings.skills.actionsLabel", {
                        name: entry.name,
                      })}
                    >
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
            <p className="text-xs text-muted-foreground truncate">
              {pending ? t("settings.skills.importing") : label}
            </p>
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
  const catalog = useOrgFsSkillCatalog();
  const { remove, upload } = useOrgFsMutations("home");
  const queryClient = useQueryClient();
  const folderInputRef = useRef<HTMLInputElement>(null);

  const [search, setSearch] = useState("");
  const [source, setSource] = useState(ALL_SOURCES);
  const [importing, setImporting] = useState(false);
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] =
    useState<OrgFsSkillCatalogEntry | null>(null);
  // Catalog id of the row whose files are still uploading, so the grid can
  // keep it inert: an early preview would cache a miss, and an early delete
  // would race the PUTs still to come.
  const [uploadingId, setUploadingId] = useState<string | null>(null);

  const refreshCatalog = () => {
    queryClient.invalidateQueries({ queryKey: KEYS.slashSkills(org.id) });
    queryClient.invalidateQueries({ queryKey: KEYS.orgFsSkills(org.id) });
  };

  /**
   * Show the delete/import result before the round trip lands, by patching the
   * one cache the grid reads. Every path ends in `refreshCatalog()`, so the
   * server is still the source of truth — the patch only covers the wait, and
   * a failure resyncs rather than replaying a rollback we'd have to keep
   * correct.
   */
  const patchCatalog = (
    update: (prev: OrgFsSkillCatalogEntry[]) => OrgFsSkillCatalogEntry[],
  ) =>
    queryClient.setQueryData<OrgFsSkillCatalogEntry[]>(
      KEYS.slashSkills(org.id),
      (prev) => update(prev ?? []),
    );

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
    const skillMd = files.find((f) => relativePath(f) === "SKILL.md");
    if (!skillMd) {
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
      // The card appears now, carrying the metadata the server will parse from
      // the very bytes we're about to upload.
      const optimistic = optimisticEntry(slug, await skillMd.text());
      patchCatalog((prev) => [optimistic, ...prev]);
      setUploadingId(optimistic.id);
      await uploadAllGroups(
        groupByDestination(files, slug),
        upload.mutateAsync,
      );
      toast.success(t("settings.skills.importSuccess", { name: slug }));
    } catch (err) {
      // A half-written tree would serve agents a broken skill, and its bare
      // directory would block the retry on the slug probe above.
      if (created) await remove.mutateAsync(dir).catch(() => {});
      toast.error(
        err instanceof Error ? err.message : t("settings.skills.importError"),
      );
    } finally {
      setUploadingId(null);
      refreshCatalog();
      setImporting(false);
    }
  }

  const lowerSearch = search.toLowerCase();
  // The org's own skills lead; the rest follow alphabetically.
  const matching = (catalog.data ?? [])
    .filter(
      (e) =>
        e.name.toLowerCase().includes(lowerSearch) ||
        (e.description ?? "").toLowerCase().includes(lowerSearch),
    )
    .sort(
      (a, b) =>
        Number(isEditable(b)) - Number(isEditable(a)) ||
        a.name.localeCompare(b.name),
    );

  // Chips come from the whole catalog; only their counts narrow with the search.
  const allSources = new Set((catalog.data ?? []).map((e) => e.source));
  const counts = new Map<string, number>();
  for (const e of matching) {
    counts.set(e.source, (counts.get(e.source) ?? 0) + 1);
  }
  const tabs = [
    {
      id: ALL_SOURCES,
      label: t("settings.skills.filterAll"),
      count: matching.length,
    },
    ...[...allSources].map((entrySource) => ({
      id: entrySource,
      label: skillOrigin(entrySource, org.name).label,
      count: counts.get(entrySource) ?? 0,
    })),
  ];

  // Only a source the catalog no longer has at all falls back to All.
  const activeSource = allSources.has(source) ? source : ALL_SOURCES;
  const filtered =
    activeSource === ALL_SOURCES
      ? matching
      : matching.filter((e) => e.source === activeSource);

  const openPreview = (entry: OrgFsSkillCatalogEntry) =>
    setPreviewPath(browsePathForEntry(entry.volume, entry.path));

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    const { id, path } = pendingDelete;
    setPendingDelete(null);
    patchCatalog((prev) => prev.filter((e) => e.id !== id));
    try {
      await remove.mutateAsync(path);
      toast.success(t("settings.skills.deleteSuccess"));
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t("settings.skills.deleteError"),
      );
    } finally {
      refreshCatalog();
    }
  };

  const importButton = (
    <Button
      size="sm"
      disabled={importing}
      onClick={() => folderInputRef.current?.click()}
      aria-label={
        importing
          ? t("settings.skills.importing")
          : t("settings.skills.importButton")
      }
    >
      <Upload01 size={14} />
      <span className="@max-sm/main-topbar:hidden">
        {importing
          ? t("settings.skills.importing")
          : t("settings.skills.importButton")}
      </span>
    </Button>
  );

  const searchInput =
    (catalog.data?.length ?? 0) > 0 &&
    !catalog.isPending &&
    !catalog.isError ? (
      <SearchInput
        value={search}
        onChange={setSearch}
        placeholder={t("settings.skills.searchPlaceholder")}
        className="w-[clamp(7rem,35cqw,23.4375rem)]"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setSearch("");
            (event.target as HTMLInputElement).blur();
          }
        }}
      />
    ) : null;

  return (
    <>
      {searchInput && (
        <Main.Topbar.Center.Portal>
          <div
            data-responsive-focus-group="settings-skills-search"
            className="hidden md:block"
          >
            {searchInput}
          </div>
        </Main.Topbar.Center.Portal>
      )}
      {searchInput && (
        <Main.Toolbar.Portal visibility="compact">
          <div
            data-responsive-focus-group="settings-skills-search"
            className="w-full md:hidden [&>*]:w-full"
          >
            {searchInput}
          </div>
        </Main.Toolbar.Portal>
      )}
      <Main.Topbar.Right.Portal>{importButton}</Main.Topbar.Right.Portal>
      <input
        ref={folderInputRef}
        type="file"
        multiple
        webkitdirectory=""
        className="hidden"
        onChange={(e) => void handleImport(e.target.files)}
      />

      <div className="h-full overflow-y-auto">
        <Main.Container width="wide">
          <Main.Stack>
            {/* One origin means the chips can only say "All" — hide them. */}
            {tabs.length > 2 && (
              <CollectionTabs
                ariaLabel={t("settings.nav.skills")}
                tabs={tabs}
                activeTab={activeSource}
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
              <div className="flex min-h-56 items-center justify-center">
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
            ) : filtered.length === 0 ? (
              <div className="flex min-h-56 items-center justify-center">
                <EmptyState
                  image={<Zap size={48} className="text-muted-foreground" />}
                  title={
                    search
                      ? t("settings.skills.noResultsTitle")
                      : t("settings.skills.emptyTitle")
                  }
                  description={
                    search
                      ? t("settings.skills.noResultsDescription", { search })
                      : t("settings.skills.emptyDescription")
                  }
                />
              </div>
            ) : (
              <div className="@container">
                <SkillsGrid>
                  {filtered.map((entry) => {
                    const pending = entry.id === uploadingId;
                    return (
                      <SkillCard
                        key={entry.id}
                        entry={entry}
                        pending={pending}
                        onOpen={() => openPreview(entry)}
                        onDelete={
                          isEditable(entry) && !pending
                            ? () => setPendingDelete(entry)
                            : undefined
                        }
                      />
                    );
                  })}
                </SkillsGrid>
              </div>
            )}
          </Main.Stack>
        </Main.Container>
      </div>

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
    </>
  );
}
