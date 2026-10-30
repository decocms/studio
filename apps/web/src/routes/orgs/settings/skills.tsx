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
import { useNavigate, useSearch } from "@tanstack/react-router";
import { AlertTriangle, Plus, Upload01, Zap } from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";
import { SearchInput } from "@decocms/ui/components/search-input.tsx";
import { SearchToggle } from "@decocms/ui/components/search-toggle.tsx";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
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
import { PAGE_INSET, Page } from "@/components/page";
import { EmptyState } from "@/components/empty-state.tsx";
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
import { useProjectMetadataPatch } from "@/hooks/use-project-metadata-patch";
import {
  bundleSummaries,
  skillDisplayName,
} from "@/components/skills/skill-catalog";
import {
  SkillsLibraryBanner,
  SkillsLibraryDialog,
} from "@/components/skills/skills-library-dialog";
import {
  DeleteSkillMenu,
  RowAction,
  type SkillsRow,
  SkillsTable,
  packageRow,
  skillRow,
} from "@/components/skills/skills-catalog-view";
import { bundleIdOfRef, bundleRef } from "@decocms/shared/skills";
import {
  groupByDestination,
  importable,
  MAX_IMPORT_FILES,
  optimisticEntry,
  relativePath,
  slugify,
  uploadAllGroups,
} from "./skills-import.ts";

/** Home-volume skills are the org's own — editable. Everything else (public
 *  sets, synced repos) is read-only here, same as in the Library. */
function isEditable(entry: OrgFsSkillCatalogEntry): boolean {
  return entry.volume === "home";
}

/** Where a skill syncs from, in words: the org's own, or the set or repo. */
function originLabel(source: string, orgName: string): string {
  const separator = source.indexOf(":");
  return separator === -1 ? orgName : source.slice(separator + 1);
}

interface SkillsPageProject {
  id: string;
  skills: string[];
}

/** The same page for an org and a project: a project adds its own picks on
 *  top, and every chat in it reads them with the org's catalog. */
export default function SettingsSkillsPage({
  project,
  context = false,
}: {
  project?: SkillsPageProject;
  /** Inside Context: a skill previews beside the table, like a file. */
  context?: boolean;
} = {}) {
  const t = useT();
  const { org } = useProjectContext();
  const catalog = useOrgFsSkillCatalog();
  const { remove, upload } = useOrgFsMutations("home");
  const queryClient = useQueryClient();
  const folderInputRef = useRef<HTMLInputElement>(null);

  const [search, setSearch] = useState("");
  const navigate = useNavigate();
  const { bundle: bundleParam, preview } = useSearch({ strict: false }) as {
    bundle?: string;
    preview?: string;
  };
  const [localBundle, setLocalBundle] = useState<string | null>(null);
  // In Context the open package is in the URL, so a preview round trip keeps it.
  const openBundle = context ? (bundleParam ?? null) : localBundle;
  const setOpenBundle = (id: string | null) => {
    if (!context) {
      setLocalBundle(id);
      return;
    }
    void navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        bundle: id ?? undefined,
        preview: undefined,
        expanded: undefined,
      }),
    });
  };
  const [libraryOpen, setLibraryOpen] = useState(false);
  const { patch } = useProjectMetadataPatch(project?.id);
  const [projectRefs, setProjectRefs] = useState(project?.skills ?? []);
  const setPicks = (next: string[]) => {
    const previous = projectRefs;
    setProjectRefs(next);
    patch({ skills: next }).catch(() => {
      setProjectRefs(previous);
      toast.error(t("settings.skills.projectSaveError"));
    });
  };
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

  const entries = catalog.data ?? [];
  const lowerSearch = search.trim().toLowerCase();
  const bundles = bundleSummaries(t, entries).filter(
    (b) => b.members.length > 0,
  );
  const bundled = new Set(bundles.flatMap((b) => b.members.map((m) => m.id)));
  const sourceOf = (entry: OrgFsSkillCatalogEntry) =>
    originLabel(entry.source, org.name);
  const inProject = (ref: string) => projectRefs.includes(ref);
  const addPick = (ref: string) => setPicks([...projectRefs, ref]);
  const removePick = (ref: string) =>
    setPicks(projectRefs.filter((r) => r !== ref));
  const current = bundles.find((b) => b.id === openBundle) ?? null;

  // The root reads like a folder: packages, then the skills no package holds.
  const rootRows: SkillsRow[] = [
    ...bundles.map((b) => packageRow(bundleRef(b.id), b)),
    ...entries.filter((e) => !bundled.has(e.id)).map(skillRow),
  ];
  const projectRows: SkillsRow[] = projectRefs.map((ref) => {
    const bundleId = bundleIdOfRef(ref);
    if (bundleId !== null) {
      const bundle = bundles.find((b) => b.id === bundleId);
      return bundle
        ? packageRow(ref, bundle)
        : {
            kind: "package",
            ref,
            title: bundleId,
            category: "other",
            bundle: null,
          };
    }
    const entry = entries.find((e) => e.id === ref);
    return entry
      ? skillRow(entry)
      : { kind: "skill", ref, title: ref, category: "other", entry: null };
  });
  const searchRows = entries
    .filter(
      (e) =>
        e.name.toLowerCase().includes(lowerSearch) ||
        skillDisplayName(e).toLowerCase().includes(lowerSearch) ||
        (e.description ?? "").toLowerCase().includes(lowerSearch),
    )
    .map(skillRow);
  // A project lists what it uses; the org lists everything it has.
  const rows = current
    ? current.members.map(skillRow)
    : project
      ? projectRows
      : lowerSearch
        ? searchRows
        : rootRows;

  const previewPathOf = (entry: OrgFsSkillCatalogEntry) =>
    browsePathForEntry(entry.volume, entry.path);
  const open = (row: SkillsRow) => {
    if (row.kind === "package") {
      if (row.bundle) setOpenBundle(row.bundle.id);
      return;
    }
    if (!row.entry) return;
    const skillDir = previewPathOf(row.entry);
    if (!context) {
      setPreviewPath(skillDir);
      return;
    }
    void navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        preview: `${skillDir}/SKILL.md`,
        expanded: undefined,
      }),
    });
  };

  const end = (row: SkillsRow) => {
    if (project) {
      // A package's skills come with it; the package is removed as a whole.
      if (current) return null;
      return (
        <RowAction
          label={t("skills.table.remove")}
          onClick={() => removePick(row.ref)}
        />
      );
    }
    if (row.kind === "skill" && row.entry && isEditable(row.entry)) {
      const entry = row.entry;
      return entry.id === uploadingId ? (
        <span className="text-meta">{t("settings.skills.importing")}</span>
      ) : (
        <DeleteSkillMenu onDelete={() => setPendingDelete(entry)} />
      );
    }
    return null;
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
  const currentRef = current ? bundleRef(current.id) : null;
  // Inside a package the page acts on the package; at the root, it adds.
  const primary = !project ? (
    importButton
  ) : currentRef ? (
    <Button
      size="sm"
      variant={inProject(currentRef) ? "outline" : "default"}
      onClick={() =>
        inProject(currentRef) ? removePick(currentRef) : addPick(currentRef)
      }
    >
      {inProject(currentRef)
        ? t("skills.table.removeFromProject")
        : t("skills.table.addToProject")}
    </Button>
  ) : (
    <Button size="sm" onClick={() => setLibraryOpen(true)}>
      <Plus size={14} />
      {t("skills.picker.add")}
    </Button>
  );

  const searchBox = (
    <SearchInput
      value={search}
      onChange={setSearch}
      placeholder={t("settings.skills.searchPlaceholder")}
      className="w-full min-w-48 md:w-56"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          setSearch("");
          (event.target as HTMLInputElement).blur();
        }
      }}
    />
  );

  const body = catalog.isPending ? (
    <div className="flex flex-col gap-px">
      {Array.from({ length: 8 }, (_, i) => (
        <Skeleton key={i} className="h-10 rounded-lg" />
      ))}
    </div>
  ) : catalog.isError ? (
    /* Never the empty state: "no skills yet" is a different fact. */
    <div className="flex items-center justify-center py-20">
      <EmptyState
        image={<AlertTriangle size={48} className="text-muted-foreground" />}
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
  ) : rows.length === 0 && project ? (
    <p className="py-10 text-center text-sm text-muted-foreground">
      {t("skills.catalog.projectEmpty")}
    </p>
  ) : rows.length === 0 ? (
    <div className="flex items-center justify-center py-20">
      <EmptyState
        image={<Zap size={48} className="text-muted-foreground" />}
        title={
          lowerSearch
            ? t("settings.skills.noResultsTitle")
            : t("settings.skills.emptyTitle")
        }
        description={
          lowerSearch
            ? t("settings.skills.noResultsDescription", { search })
            : t("settings.skills.emptyDescription")
        }
        actions={false}
      />
    </div>
  ) : (
    <SkillsTable
      rows={rows}
      second={current ? "source" : "category"}
      sourceOf={sourceOf}
      selected={
        rows.find(
          (row) =>
            row.kind === "skill" &&
            row.entry &&
            preview === `${previewPathOf(row.entry)}/SKILL.md`,
        )?.ref
      }
      onOpen={open}
      end={end}
    />
  );

  return (
    <Page>
      {context ? (
        <>
          {current && (
            <Page.Breadcrumbs
              after="context-section"
              parent={{ onSelect: () => setOpenBundle(null) }}
              items={[{ key: "skills-package", label: current.title }]}
            />
          )}
          <Page.Actions
            secondary={
              !project && (
                <SearchToggle
                  value={search}
                  onChange={setSearch}
                  label={t("library.context.search")}
                  placeholder={t("settings.skills.searchPlaceholder")}
                  clearLabel={t("library.library.clearSearch")}
                />
              )
            }
          >
            {primary}
          </Page.Actions>
        </>
      ) : null}
      <Page.Content>
        <div
          className={cn(
            "mx-auto flex w-full flex-col gap-4",
            context
              ? cn(PAGE_INSET, "pt-4 pb-8")
              : "max-w-[1200px] px-4 py-6 md:px-8",
          )}
        >
          {!context && (
            <>
              <Page.Title actions={primary}>
                {current?.title ?? t("settings.skills.pageTitle")}
              </Page.Title>
              <div className="flex flex-wrap items-center justify-between gap-3">
                {current ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setOpenBundle(null)}
                  >
                    {t("settings.skills.pageTitle")}
                  </Button>
                ) : (
                  <span />
                )}
                {!project && searchBox}
              </div>
            </>
          )}
          <input
            ref={folderInputRef}
            type="file"
            multiple
            webkitdirectory=""
            className="hidden"
            onChange={(e) => void handleImport(e.target.files)}
          />
          {project && !current && (
            <SkillsLibraryBanner
              packages={bundles.length}
              skills={entries.length}
              onBrowse={() => setLibraryOpen(true)}
            />
          )}
          {body}
        </div>
      </Page.Content>

      {project && (
        <SkillsLibraryDialog
          open={libraryOpen}
          onOpenChange={setLibraryOpen}
          bundles={bundles}
          entries={entries}
          taken={projectRefs}
          onAdd={addPick}
        />
      )}

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
            <AlertDialogAction onClick={confirmDelete} variant="destructive">
              {t("settings.skills.deleteButton")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Page>
  );
}
