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
  type OrgFsSkillCatalogEntry,
  useOrgFsMutations,
  useOrgFsSkillCatalog,
} from "@/hooks/use-org-fs";
import { browsePathForEntry } from "@/layouts/library/location";
import { SkillPreviewDialog } from "@/layouts/library/skill-preview";

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

function slugify(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "skill"
  );
}

/** A picked file's path relative to the folder root the user chose. */
function relativePath(file: File): string {
  const [, ...rest] = file.webkitRelativePath.split("/");
  return rest.length > 0 ? rest.join("/") : file.name;
}

/**
 * Map a picked folder onto `home/skills/<slug>/…`, grouped by destination
 * directory: the upload endpoint takes one directory plus files whose own
 * `name` completes the path, so nested files must be grouped rather than
 * flattened (which would collapse `references/style.md` onto the root).
 */
function groupByDestination(files: File[], slug: string): Map<string, File[]> {
  const groups = new Map<string, File[]>();
  for (const file of files) {
    const segments = relativePath(file).split("/");
    segments.pop();
    const dir = ["skills", slug, ...segments].join("/");
    groups.set(dir, [...(groups.get(dir) ?? []), file]);
  }
  return groups;
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
  const catalog = useOrgFsSkillCatalog();
  const { remove, upload } = useOrgFsMutations("home");
  const queryClient = useQueryClient();
  const folderInputRef = useRef<HTMLInputElement>(null);

  const [search, setSearch] = useState("");
  const [source, setSource] = useState(ALL_SOURCES);
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] =
    useState<OrgFsSkillCatalogEntry | null>(null);

  const refreshCatalog = () => {
    queryClient.invalidateQueries({ queryKey: KEYS.slashSkills(org.id) });
    queryClient.invalidateQueries({ queryKey: KEYS.orgFsSkills(org.id) });
  };

  async function handleImport(fileList: FileList | null) {
    const files = [...(fileList ?? [])];
    // Reset first: picking the same folder twice must re-fire `change`.
    if (folderInputRef.current) folderInputRef.current.value = "";
    if (files.length === 0) return;

    const folder = files[0]?.webkitRelativePath.split("/")[0] ?? "";
    if (!files.some((f) => relativePath(f) === "SKILL.md")) {
      toast.error(t("settings.skills.importMissingSkillMd"));
      return;
    }

    try {
      for (const [dir, group] of groupByDestination(files, slugify(folder))) {
        await upload.mutateAsync({ dir, files: group });
      }
      refreshCatalog();
      toast.success(t("settings.skills.importSuccess", { name: folder }));
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t("settings.skills.importError"),
      );
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

  // Derived from the catalog — which sets/repos exist is deployment + org config.
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
    ...[...counts].map(([entrySource, count]) => ({
      id: entrySource,
      label: skillOrigin(entrySource, org.name).label,
      count,
    })),
  ];

  // A selection whose source vanished falls back to All, never an empty grid.
  const activeSource = counts.has(source) ? source : ALL_SOURCES;
  const filtered =
    activeSource === ALL_SOURCES
      ? matching
      : matching.filter((e) => e.source === activeSource);

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
      disabled={upload.isPending}
      onClick={() => folderInputRef.current?.click()}
    >
      <Upload01 size={14} />
      {upload.isPending
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
            ) : filtered.length === 0 ? (
              <div className="flex items-center justify-center py-20">
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
                  actions={!search && importButton}
                />
              </div>
            ) : (
              <div className="@container">
                <SkillsGrid>
                  {filtered.map((entry) => (
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
                </SkillsGrid>
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
