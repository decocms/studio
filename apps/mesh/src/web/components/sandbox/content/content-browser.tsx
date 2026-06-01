import { Suspense, lazy, useState } from "react";
import {
  AlertCircle,
  Copy01,
  DotsHorizontal,
  Edit01,
  Flag01,
  Globe02,
  LayoutAlt01,
  Loading01,
  Plus,
  SearchLg,
  Trash01,
} from "@untitledui/icons";
import { toast } from "sonner";
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
import { Button } from "@deco/ui/components/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@deco/ui/components/dropdown-menu.tsx";
import { ScrollArea } from "@deco/ui/components/scroll-area.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { cn } from "@deco/ui/lib/utils.js";
import {
  SELF_MCP_ALIAS_ID,
  parseBranchMap,
  useMCPClient,
  useProjectContext,
} from "@decocms/mesh-sdk";
import { useInsetContext } from "@/web/layouts/agent-shell-layout";
import { authClient } from "@/web/lib/auth-client";
import { useChatTask } from "@/web/components/chat/context";
import { useDecofile } from "@/web/components/sections-editor/use-decofile";
import { useLiveMeta } from "@/web/components/sections-editor/use-live-meta";
import { useSaveBlock } from "@/web/components/sections-editor/use-save-block";
import { useDeleteBlock } from "@/web/components/sections-editor/use-delete-block";
import {
  extractGlobalSections,
  extractPages,
  type GlobalSectionEntry,
  type PageEntry,
} from "@/web/components/sections-editor/page-list";
import { normalizePagePath } from "@/web/components/sections-editor/page-path-utils";
import {
  appendPageVariantSections,
  getPageVariantCount,
  getPageVariantSectionsAt,
} from "@/web/components/sections-editor/page-variants";
import type { SectionCatalogEntry } from "@/web/components/sections-editor/section-catalog";
import { useNavigate } from "@tanstack/react-router";
import { useSandboxEvents } from "@/web/components/sandbox/hooks/use-sandbox-events";
import {
  sandboxUserStop,
  useIsSandboxStartPending,
  useSandboxStart,
  type SandboxStartArgs,
} from "@/web/components/sandbox/hooks/use-sandbox-start";
import { SandboxStateCard } from "@/web/components/sandbox/preview/state-card";
import { derivePhaseProgress } from "@/web/components/sandbox/preview/derive-phase-progress";
import {
  computePreviewState,
  type LifecycleFailure,
} from "@/web/components/sandbox/preview/preview-state";
import {
  buildDuplicatePage,
  buildEmptyPage,
  generateUniquePageBlockKey,
  nextUniqueBlockKey,
  nextUniqueName,
  nextUniquePagePath,
} from "./content-mutations";
import { PageFormDialog, type PageFormMode } from "./page-form-dialog";
import { SectionRenameDialog } from "./section-rename-dialog";

const SectionsEditor = lazy(() =>
  import("@/web/components/sections-editor/sections-editor").then((m) => ({
    default: m.SectionsEditor,
  })),
);

const AddSectionModal = lazy(() =>
  import("@/web/components/sections-editor/add-section-modal").then((m) => ({
    default: m.AddSectionModal,
  })),
);

const VARIANT_GREEN = "oklch(0.65 0.15 160)";

type CollectionId = "pages" | "sections";

type Selection =
  | { collection: "pages"; key: string; path: string }
  | { collection: "sections"; key: string }
  | null;

type PageDialogState = {
  mode: PageFormMode;
  sourceKey: string | null; // null for "create"
  initialName: string;
  initialPath: string;
} | null;

type DeleteTarget =
  | { kind: "page"; key: string; label: string }
  | { kind: "section"; key: string; label: string }
  | null;

export function ContentBrowser() {
  const inset = useInsetContext();
  const { data: session } = authClient.useSession();
  const { currentBranch: branch } = useChatTask();
  const { org } = useProjectContext();

  const virtualMcpId = inset?.entity?.id ?? null;
  const userId = session?.user?.id;
  const metadata = inset?.entity?.metadata;
  const branchMap =
    userId && branch
      ? parseBranchMap(metadata?.sandboxMap?.[userId]?.[branch])
      : {};
  const branchMapEntries = Object.values(branchMap);
  const vmEntry =
    branchMapEntries.find((e) => e.sandboxProviderKind !== "user-desktop") ??
    branchMapEntries[0];
  const previewUrl = vmEntry?.previewUrl ?? null;

  const vmEvents = useSandboxEvents();
  const lifecyclePhase = vmEvents.lifecycle.phase;

  const mcpClient = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: inset?.entity?.organization_id ?? "",
    orgSlug: org.slug,
  });
  const startVm = useSandboxStart(mcpClient);
  const vmStartPending = useIsSandboxStartPending(
    virtualMcpId ?? undefined,
    branch ?? undefined,
  );
  const navigate = useNavigate();

  const triggerStart = () => {
    if (!virtualMcpId) return;
    const args: SandboxStartArgs = { virtualMcpId };
    if (branch) args.branch = branch;
    startVm.mutate(args);
  };

  // Mirror Preview's state machine so both tabs agree on what the
  // sandbox is doing. Without this Content would always show
  // "never-started" even when the sandbox is suspended/crashed/errored.
  const lifecycleFailure: LifecycleFailure | null =
    lifecyclePhase === "start-failed" ||
    lifecyclePhase === "install-failed" ||
    lifecyclePhase === "clone-failed"
      ? lifecyclePhase
      : null;
  const lifecycleFailureError =
    lifecycleFailure && "error" in vmEvents.lifecycle
      ? (vmEvents.lifecycle.error ?? null)
      : null;
  const upstreamStatus =
    lifecyclePhase === "running"
      ? "online"
      : lifecyclePhase === "crashed"
        ? "offline"
        : "booting";
  const userStopped =
    !!virtualMcpId &&
    !!branch &&
    sandboxUserStop.isStopped(virtualMcpId, branch);
  const sandboxState = computePreviewState({
    previewUrl,
    status: upstreamStatus,
    // Content doesn't render an iframe, so the iframe/no-html branches
    // are dead. Pass `true` to short-circuit them to "iframe" (= ready).
    htmlSupport: true,
    suspended: vmEvents.suspended,
    appPaused: vmEvents.status.state === "paused",
    vmStartPending,
    lastStartError: startVm.error?.message ?? null,
    lifecycleFailure,
    lifecycleFailureError,
    claimPhase: vmEvents.phase,
    notFound: vmEvents.notFound,
    userStopped,
  });

  // Send the user to Preview for terminal/file inspection — Content has
  // neither surface, so the dev-script-failed / crashed buttons would be
  // dead ends here.
  const openPreview = () =>
    navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({ ...prev, main: "preview" }),
      replace: true,
    });

  // `no-html` can't happen here — htmlSupport is hard-coded to true so
  // computePreviewState routes "dev server is up" to `iframe`. Keep both
  // in the guard so TS narrows correctly.
  if (sandboxState.kind !== "iframe" && sandboxState.kind !== "no-html") {
    return (
      <SandboxStateRenderer
        state={sandboxState}
        claimPhase={vmEvents.phase}
        lifecycle={vmEvents.lifecycle}
        onStart={triggerStart}
        onOpenPreview={openPreview}
      />
    );
  }

  if (!virtualMcpId || !branch) {
    return <EmptyMessage title="Waiting for sandbox context…" />;
  }

  return (
    <ContentBrowserReady
      orgSlug={org.slug}
      virtualMcpId={virtualMcpId}
      branch={branch}
      previewUrl={previewUrl}
    />
  );
}

function ContentBrowserReady({
  orgSlug,
  virtualMcpId,
  branch,
  previewUrl,
}: {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
  previewUrl: string | null;
}) {
  const fetchParams = { orgSlug, virtualMcpId, branch };
  const { data: decofile, isLoading: decofileLoading } =
    useDecofile(fetchParams);
  const { data: meta, isLoading: metaLoading } = useLiveMeta(fetchParams);

  const saveBlock = useSaveBlock(fetchParams);
  const deleteBlock = useDeleteBlock(fetchParams);

  const [activeCollection, setActiveCollection] =
    useState<CollectionId>("pages");
  const [selection, setSelection] = useState<Selection>(null);
  const [searchQuery, setSearchQuery] = useState("");
  // Reset search when switching collections (derived-state sync pattern)
  const [prevCollection, setPrevCollection] = useState(activeCollection);
  if (prevCollection !== activeCollection) {
    setPrevCollection(activeCollection);
    setSearchQuery("");
  }

  // Dialog state
  const [pageDialog, setPageDialog] = useState<PageDialogState>(null);
  const [pageDialogError, setPageDialogError] = useState<string | undefined>();
  const [addSectionOpen, setAddSectionOpen] = useState(false);
  const [renameSectionKey, setRenameSectionKey] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget>(null);

  if (decofileLoading || metaLoading) {
    return (
      <div className="h-full w-full flex items-center justify-center">
        <Loading01 size={20} className="animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!decofile || !meta) {
    return <EmptyMessage title="Could not load site data." />;
  }

  const pages = extractPages(decofile).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const globalSections = extractGlobalSections(decofile, meta);

  if (pages.length === 0 && globalSections.length === 0) {
    return (
      <EmptyMessage
        icon={AlertCircle}
        title="No editable content"
        description="This project doesn't expose any Deco pages or sections."
      />
    );
  }

  const counts: Record<CollectionId, number> = {
    pages: pages.length,
    sections: globalSections.length,
  };
  const takenPaths = new Set(pages.map((p) => normalizePagePath(p.path)));
  const takenPageNames = new Set(pages.map((p) => p.name));
  const takenSectionNames = new Set(globalSections.map((s) => s.name));

  // ------------------ Variant ------------------
  const handleAddPageVariant = async (page: PageEntry) => {
    const fullPageData = decofile[page.key] as Record<string, unknown>;
    if (!fullPageData) return;
    const variantCount = getPageVariantCount(decofile, page.key);
    const seedSections = getPageVariantSectionsAt(
      decofile,
      page.key,
      Math.max(0, variantCount - 1),
    );
    const updatedSections = appendPageVariantSections(
      fullPageData.sections,
      seedSections,
    );
    if (!updatedSections) return;
    try {
      await saveBlock.mutateAsync({
        blockKey: page.key,
        data: { ...fullPageData, sections: updatedSections },
      });
      toast.success(`Variant added to "${page.name}"`);
      setSelection({ collection: "pages", key: page.key, path: page.path });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not add variant");
    }
  };

  // ------------------ Page CRUD ------------------
  const openCreatePage = () => {
    setPageDialogError(undefined);
    setPageDialog({
      mode: "create",
      sourceKey: null,
      initialName: "My new page",
      initialPath: "/example",
    });
  };

  const openDuplicatePage = (page: PageEntry) => {
    setPageDialogError(undefined);
    setPageDialog({
      mode: "duplicate",
      sourceKey: page.key,
      initialName: nextUniqueName(takenPageNames, page.name),
      initialPath: nextUniquePagePath(takenPaths, page.path),
    });
  };

  const openRenamePage = (page: PageEntry) => {
    setPageDialogError(undefined);
    setPageDialog({
      mode: "rename",
      sourceKey: page.key,
      initialName: page.name,
      initialPath: page.path,
    });
  };

  const submitPageDialog = async (values: { name: string; path: string }) => {
    if (!pageDialog) return;
    const { mode, sourceKey } = pageDialog;
    try {
      if (mode === "create") {
        const data = buildEmptyPage(values.name, values.path);
        const key = generateUniquePageBlockKey(decofile, values.name);
        await saveBlock.mutateAsync({ blockKey: key, data });
        toast.success(`Created "${values.name}"`);
        setSelection({ collection: "pages", key, path: values.path });
      } else if (mode === "duplicate" && sourceKey) {
        const source = decofile[sourceKey] as
          | Record<string, unknown>
          | undefined;
        if (!source) throw new Error("Source page not found");
        const { key, data } = buildDuplicatePage({
          source,
          pages,
          newName: values.name,
          newPath: values.path,
        });
        await saveBlock.mutateAsync({ blockKey: key, data });
        toast.success(`Duplicated as "${values.name}"`);
        setSelection({ collection: "pages", key, path: values.path });
      } else if (mode === "rename" && sourceKey) {
        const source = decofile[sourceKey] as
          | Record<string, unknown>
          | undefined;
        if (!source) throw new Error("Page not found");
        const data: Record<string, unknown> = {
          ...source,
          name: values.name,
          path: values.path,
        };
        await saveBlock.mutateAsync({ blockKey: sourceKey, data });
        toast.success("Page updated");
        if (selection?.collection === "pages" && selection.key === sourceKey) {
          setSelection({
            collection: "pages",
            key: sourceKey,
            path: values.path,
          });
        }
      }
      setPageDialog(null);
    } catch (err) {
      setPageDialogError(err instanceof Error ? err.message : "Save failed");
    }
  };

  const validatePageValues = ({
    path,
  }: {
    name: string;
    path: string;
  }): string | null => {
    if (!pageDialog) return null;
    const targetNorm = normalizePagePath(path);
    const sourceNorm =
      pageDialog.mode === "rename"
        ? normalizePagePath(pageDialog.initialPath)
        : null;
    if (sourceNorm !== targetNorm && takenPaths.has(targetNorm)) {
      return `A page with path "${path}" already exists.`;
    }
    return null;
  };

  // ------------------ Section CRUD ------------------
  const handleCreateSection = async (entry: SectionCatalogEntry) => {
    const baseLabel = (entry.title || entry.resolveType.split("/").pop() || "")
      .replace(/\.(tsx?|jsx?)$/, "")
      .replace(/[^A-Za-z0-9_-]/g, "");
    const safeBase =
      /^[A-Za-z]/.test(baseLabel) && baseLabel.length > 0
        ? baseLabel
        : "Section";
    const newKey = nextUniqueBlockKey(decofile, safeBase);
    const data: Record<string, unknown> = {
      __resolveType: entry.resolveType,
      name: newKey,
    };
    try {
      await saveBlock.mutateAsync({ blockKey: newKey, data });
      toast.success(`Created section "${newKey}"`);
      setAddSectionOpen(false);
      setSelection({ collection: "sections", key: newKey });
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not create section",
      );
    }
  };

  const handleDuplicateSection = async (section: GlobalSectionEntry) => {
    const source = decofile[section.key] as Record<string, unknown> | undefined;
    if (!source) {
      toast.error("Section not found.");
      return;
    }
    const newKey = nextUniqueBlockKey(decofile, section.key);
    const newName = nextUniqueName(takenSectionNames, section.name);
    const data: Record<string, unknown> = { ...source, name: newName };
    try {
      await saveBlock.mutateAsync({ blockKey: newKey, data });
      toast.success(`Duplicated "${section.name}"`);
      setSelection({ collection: "sections", key: newKey });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Duplicate failed");
    }
  };

  const handleRenameSection = async (newName: string) => {
    if (!renameSectionKey) return;
    const source = decofile[renameSectionKey] as
      | Record<string, unknown>
      | undefined;
    if (!source) {
      toast.error("Section not found.");
      return;
    }
    try {
      await saveBlock.mutateAsync({
        blockKey: renameSectionKey,
        data: { ...source, name: newName },
      });
      toast.success("Section renamed");
      setRenameSectionKey(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Rename failed");
    }
  };

  // ------------------ Delete ------------------
  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const { kind, key, label } = deleteTarget;
    try {
      await deleteBlock.mutateAsync({ blockKey: key });
      toast.success(`Deleted "${label}"`);
      if (kind === "page") {
        if (selection?.collection === "pages" && selection.key === key) {
          setSelection(null);
        }
      } else if (
        selection?.collection === "sections" &&
        selection.key === key
      ) {
        setSelection(null);
      }
      setDeleteTarget(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Delete failed");
    }
  };

  // ------------------ Render ------------------
  return (
    <div className="flex h-full w-full">
      <CollectionsSidebar
        active={activeCollection}
        counts={counts}
        onSelect={(id) => {
          setActiveCollection(id);
          setSelection(null);
        }}
      />
      <ItemList
        activeCollection={activeCollection}
        pages={pages}
        sections={globalSections}
        decofile={decofile}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        selection={selection}
        onSelect={setSelection}
        previewUrl={previewUrl}
        onCreate={() => {
          if (activeCollection === "pages") {
            openCreatePage();
          } else if (!previewUrl) {
            toast.error("Start the preview dev server to add sections.");
          } else {
            setAddSectionOpen(true);
          }
        }}
        onDuplicatePage={openDuplicatePage}
        onRenamePage={openRenamePage}
        onAddPageVariant={handleAddPageVariant}
        onDeletePage={(page) =>
          setDeleteTarget({ kind: "page", key: page.key, label: page.name })
        }
        onDuplicateSection={handleDuplicateSection}
        onRenameSection={(s) => setRenameSectionKey(s.key)}
        onDeleteSection={(s) =>
          setDeleteTarget({ kind: "section", key: s.key, label: s.name })
        }
      />
      <div className="flex-1 min-w-0">
        {selection ? (
          <Suspense
            fallback={
              <div className="h-full flex items-center justify-center">
                <Loading01
                  size={20}
                  className="animate-spin text-muted-foreground"
                />
              </div>
            }
          >
            <SectionsEditor
              key={
                selection.collection === "pages"
                  ? `page:${selection.key}`
                  : `section:${selection.key}`
              }
              orgSlug={orgSlug}
              virtualMcpId={virtualMcpId}
              branch={branch}
              previewReady
              previewUrl={previewUrl ?? undefined}
              currentPath={
                selection.collection === "pages" ? selection.path : "/"
              }
              activePageBlockKey={
                selection.collection === "pages" ? selection.key : null
              }
              activeGlobalBlockKey={
                selection.collection === "sections" ? selection.key : null
              }
            />
          </Suspense>
        ) : (
          <EmptyMessage
            title={
              activeCollection === "pages"
                ? "Select a page to edit"
                : "Select a section to edit"
            }
            description={
              activeCollection === "pages"
                ? 'Pick a page from the list, or click "+ New" to create one.'
                : 'Pick a section from the list, or click "+ New" to create one.'
            }
          />
        )}
      </div>

      {/* Page create/duplicate/rename dialog */}
      {pageDialog && (
        <PageFormDialog
          open={!!pageDialog}
          mode={pageDialog.mode}
          initialName={pageDialog.initialName}
          initialPath={pageDialog.initialPath}
          isPending={saveBlock.isPending}
          error={pageDialogError}
          validate={validatePageValues}
          onSubmit={submitPageDialog}
          onOpenChange={(next) => {
            if (!next) {
              setPageDialog(null);
              setPageDialogError(undefined);
            }
          }}
        />
      )}

      {/* Section rename dialog */}
      {renameSectionKey && (
        <SectionRenameDialog
          open={!!renameSectionKey}
          blockKey={renameSectionKey}
          initialName={
            globalSections.find((s) => s.key === renameSectionKey)?.name ??
            renameSectionKey
          }
          isPending={saveBlock.isPending}
          onSubmit={handleRenameSection}
          onOpenChange={(next) => {
            if (!next) setRenameSectionKey(null);
          }}
        />
      )}

      {/* Create global section — reuses the section gallery */}
      {addSectionOpen && previewUrl && (
        <Suspense fallback={null}>
          <AddSectionModal
            open={addSectionOpen}
            onOpenChange={setAddSectionOpen}
            meta={meta}
            decofile={decofile}
            previewBaseUrl={previewUrl}
            onSelect={handleCreateSection}
          />
        </Suspense>
      )}

      {/* Delete confirmation */}
      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(next) => {
          if (!next && !deleteBlock.isPending) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {deleteTarget?.kind === "page" ? "page" : "section"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget?.kind === "page"
                ? `"${deleteTarget.label}" will be removed permanently. This can't be undone.`
                : deleteTarget?.kind === "section"
                  ? `"${deleteTarget.label}" will be removed. Pages that still reference it will lose this section.`
                  : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteBlock.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void confirmDelete();
              }}
              disabled={deleteBlock.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteBlock.isPending ? (
                <>
                  <Loading01 size={14} className="animate-spin" />
                  Deleting…
                </>
              ) : (
                "Delete"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function CollectionsSidebar({
  active,
  counts,
  onSelect,
}: {
  active: CollectionId;
  counts: Record<CollectionId, number>;
  onSelect: (id: CollectionId) => void;
}) {
  return (
    <div className="w-[208px] shrink-0 border-r flex flex-col">
      <div className="px-3 h-12 flex items-center border-b shrink-0">
        <span className="text-sm font-medium">Content</span>
      </div>
      <nav className="flex flex-col p-1.5 gap-0.5">
        <CollectionRow
          id="pages"
          icon={LayoutAlt01}
          label="Pages"
          count={counts.pages}
          active={active === "pages"}
          onSelect={onSelect}
        />
        <CollectionRow
          id="sections"
          icon={Globe02}
          label="Sections"
          count={counts.sections}
          active={active === "sections"}
          onSelect={onSelect}
        />
      </nav>
    </div>
  );
}

function CollectionRow({
  id,
  icon: Icon,
  label,
  count,
  active,
  onSelect,
}: {
  id: CollectionId;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  label: string;
  count: number;
  active: boolean;
  onSelect: (id: CollectionId) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(id)}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors cursor-pointer",
        active
          ? "bg-accent text-accent-foreground"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      <Icon size={16} className="shrink-0" />
      <span className="flex-1 truncate">{label}</span>
      <span
        className={cn(
          "shrink-0 text-xs tabular-nums",
          active ? "text-accent-foreground/70" : "text-muted-foreground/70",
        )}
      >
        {count}
      </span>
    </button>
  );
}

function ItemList({
  activeCollection,
  pages,
  sections,
  decofile,
  previewUrl,
  searchQuery,
  onSearchChange,
  selection,
  onSelect,
  onCreate,
  onDuplicatePage,
  onRenamePage,
  onAddPageVariant,
  onDeletePage,
  onDuplicateSection,
  onRenameSection,
  onDeleteSection,
}: {
  activeCollection: CollectionId;
  pages: PageEntry[];
  sections: GlobalSectionEntry[];
  decofile: Record<string, unknown>;
  previewUrl: string | null;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  selection: Selection;
  onSelect: (next: Selection) => void;
  onCreate: () => void;
  onDuplicatePage: (page: PageEntry) => void;
  onRenamePage: (page: PageEntry) => void;
  onAddPageVariant: (page: PageEntry) => void;
  onDeletePage: (page: PageEntry) => void;
  onDuplicateSection: (section: GlobalSectionEntry) => void;
  onRenameSection: (section: GlobalSectionEntry) => void;
  onDeleteSection: (section: GlobalSectionEntry) => void;
}) {
  const q = searchQuery.toLowerCase();
  const filteredPages = pages.filter(
    (p) =>
      !q ||
      p.name.toLowerCase().includes(q) ||
      p.path.toLowerCase().includes(q),
  );
  const filteredSections = sections.filter(
    (s) =>
      !q ||
      s.name.toLowerCase().includes(q) ||
      s.key.toLowerCase().includes(q) ||
      s.resolveType.toLowerCase().includes(q),
  );

  const placeholder =
    activeCollection === "pages" ? "Search pages…" : "Search sections…";
  const createTooltip =
    activeCollection === "pages" ? "Create new page" : "Create new section";
  const sectionCreateBlocked = activeCollection === "sections" && !previewUrl;
  const createDisabledReason = sectionCreateBlocked
    ? "Start the preview dev server to add sections"
    : undefined;

  return (
    <div className="w-[300px] shrink-0 border-r flex flex-col min-h-0">
      <div className="px-2 h-12 flex items-center gap-1 border-b shrink-0">
        <div className="flex flex-1 items-center gap-2 pl-1">
          <SearchLg
            size={14}
            className="shrink-0 text-muted-foreground"
            aria-hidden
          />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder={placeholder}
            aria-label={placeholder}
            className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              onClick={onCreate}
              disabled={sectionCreateBlocked}
              aria-label={createTooltip}
              aria-disabled={sectionCreateBlocked}
            >
              <Plus size={14} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {createDisabledReason ?? createTooltip}
          </TooltipContent>
        </Tooltip>
      </div>
      <ScrollArea className="flex-1 min-h-0">
        <div className="flex flex-col gap-1 p-1.5">
          {activeCollection === "pages" ? (
            filteredPages.length === 0 ? (
              <ListEmpty
                hasItems={pages.length > 0}
                emptyLabel="No pages yet."
                emptyHint='Click "+" to create your first page.'
              />
            ) : (
              filteredPages.map((page) => {
                const isActive =
                  selection?.collection === "pages" &&
                  selection.key === page.key;
                const variantCount = getPageVariantCount(decofile, page.key);
                return (
                  <ItemRow
                    key={page.key}
                    icon={LayoutAlt01}
                    title={page.name}
                    subtitle={page.path}
                    active={isActive}
                    variantCount={variantCount}
                    onClick={() =>
                      onSelect({
                        collection: "pages",
                        key: page.key,
                        path: page.path,
                      })
                    }
                    menu={
                      <ItemActions
                        onDuplicate={() => onDuplicatePage(page)}
                        onRename={() => onRenamePage(page)}
                        onAddVariant={() => onAddPageVariant(page)}
                        onDelete={() => onDeletePage(page)}
                      />
                    }
                  />
                );
              })
            )
          ) : filteredSections.length === 0 ? (
            <ListEmpty
              hasItems={sections.length > 0}
              emptyLabel="No saved sections yet."
              emptyHint='Click "+" to create one, or save a section from a page.'
            />
          ) : (
            filteredSections.map((section) => {
              const isActive =
                selection?.collection === "sections" &&
                selection.key === section.key;
              const typeLabel = section.resolveType
                .split("/")
                .pop()
                ?.replace(/\.tsx?$/, "");
              return (
                <ItemRow
                  key={section.key}
                  icon={Globe02}
                  title={section.name}
                  subtitle={typeLabel ?? section.resolveType}
                  active={isActive}
                  onClick={() =>
                    onSelect({ collection: "sections", key: section.key })
                  }
                  menu={
                    <ItemActions
                      onDuplicate={() => onDuplicateSection(section)}
                      onRename={() => onRenameSection(section)}
                      onDelete={() => onDeleteSection(section)}
                    />
                  }
                />
              );
            })
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

function ItemRow({
  icon: Icon,
  title,
  subtitle,
  active,
  variantCount,
  onClick,
  menu,
}: {
  icon: React.ComponentType<{
    size?: number;
    className?: string;
    style?: React.CSSProperties;
  }>;
  title: string;
  subtitle: string;
  active: boolean;
  variantCount?: number;
  onClick: () => void;
  menu?: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "group relative flex items-center rounded-md transition-colors",
        active ? "bg-accent text-accent-foreground" : "hover:bg-muted",
      )}
    >
      <button
        type="button"
        onClick={onClick}
        className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-2.5 py-2 text-left cursor-pointer"
      >
        {variantCount && variantCount > 1 ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Icon
                size={16}
                className="shrink-0"
                style={{ color: VARIANT_GREEN }}
              />
            </TooltipTrigger>
            <TooltipContent side="right">
              {variantCount} variants
            </TooltipContent>
          </Tooltip>
        ) : (
          <Icon
            size={16}
            className={cn(
              "shrink-0",
              active ? "text-accent-foreground" : "text-muted-foreground",
            )}
          />
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{title}</span>
          <span
            className={cn(
              "block truncate text-xs",
              active ? "text-accent-foreground/70" : "text-muted-foreground",
            )}
          >
            {subtitle}
          </span>
        </span>
      </button>
      {menu && (
        <div
          className={cn(
            "pr-1 opacity-0 transition-opacity group-hover:opacity-100",
            active && "opacity-100",
          )}
        >
          {menu}
        </div>
      )}
    </div>
  );
}

function ItemActions({
  onDuplicate,
  onRename,
  onAddVariant,
  onDelete,
}: {
  onDuplicate: () => void;
  onRename: () => void;
  onAddVariant?: () => void;
  onDelete: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="More actions"
          className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground cursor-pointer"
          onClick={(e) => e.stopPropagation()}
        >
          <DotsHorizontal size={14} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuItem onClick={onRename}>
          <Edit01 size={14} />
          Rename
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onDuplicate}>
          <Copy01 size={14} />
          Duplicate
        </DropdownMenuItem>
        {onAddVariant && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={onAddVariant}
              className="cursor-pointer"
              style={{ color: VARIANT_GREEN }}
            >
              <Flag01 size={14} style={{ color: VARIANT_GREEN }} />
              Add variant
            </DropdownMenuItem>
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={onDelete}
          className="text-destructive focus:text-destructive"
        >
          <Trash01 size={14} />
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ListEmpty({
  hasItems,
  emptyLabel,
  emptyHint,
}: {
  hasItems: boolean;
  emptyLabel: string;
  emptyHint: string;
}) {
  return (
    <div className="px-3 py-6 text-center text-xs text-muted-foreground">
      {hasItems ? (
        "No results match your search."
      ) : (
        <>
          <div>{emptyLabel}</div>
          <div className="mt-1 text-muted-foreground/80">{emptyHint}</div>
        </>
      )}
    </div>
  );
}

/**
 * Renders the SandboxStateCard variant that matches the current
 * sandbox state. Mirrors Preview's switch so Content shows the same
 * "Sandbox is paused" / "Sandbox crashed" / etc. cards instead of
 * always falling back to "never-started".
 *
 * For card actions that don't make sense in Content (View logs,
 * Browse files), we redirect the user to the Preview tab — Content
 * has no terminal or file explorer of its own.
 */
function SandboxStateRenderer({
  state,
  claimPhase,
  lifecycle,
  onStart,
  onOpenPreview,
}: {
  state: Exclude<
    ReturnType<typeof computePreviewState>,
    { kind: "iframe" } | { kind: "no-html" }
  >;
  claimPhase: ReturnType<typeof useSandboxEvents>["phase"];
  lifecycle: ReturnType<typeof useSandboxEvents>["lifecycle"];
  onStart: () => void;
  onOpenPreview: () => void;
}) {
  const progress = derivePhaseProgress({ claimPhase, lifecycle });

  switch (state.kind) {
    case "never-started":
      return <SandboxStateCard kind="never-started" onStart={onStart} />;
    case "starting-now":
      return (
        <SandboxStateCard
          kind="starting-now"
          progress={progress}
          claimPhase={claimPhase}
        />
      );
    case "suspended":
      return <SandboxStateCard kind="suspended" onResume={onStart} />;
    case "crashed":
      return <SandboxStateCard kind="crashed" onOpenTerminal={onOpenPreview} />;
    case "errored":
      return (
        <SandboxStateCard
          kind="errored"
          progress={progress}
          logSource="setup"
          errorLine={state.error.split("\n")[0] ?? "Failed to start"}
          onRetry={onStart}
          drawerOpen
        />
      );
    case "dev-script-failed":
      return (
        <SandboxStateCard
          kind="dev-script-failed"
          progress={progress}
          logSource={state.failure === "start-failed" ? "dev" : "setup"}
          errorLine={state.error.split("\n")[0] ?? "Dev script exited"}
          onRetry={onStart}
          onOpenTerminal={onOpenPreview}
          onBrowseFiles={onOpenPreview}
          drawerOpen
        />
      );
  }
}

function EmptyMessage({
  icon: Icon,
  title,
  description,
}: {
  icon?: React.ComponentType<{ size?: number; className?: string }>;
  title: string;
  description?: string;
}) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
      {Icon && <Icon size={24} className="text-muted-foreground/60" />}
      <div>{title}</div>
      {description && (
        <div className="text-xs text-muted-foreground/80 max-w-sm">
          {description}
        </div>
      )}
    </div>
  );
}
