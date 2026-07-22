import { Suspense, lazy, useState } from "react";
import { type Query } from "@tanstack/react-query";
import {
  AlertCircle,
  CornerUpRight,
  File02,
  Globe02,
  Grid01,
  LayoutAlt01,
  Loading01,
  Plus,
  SearchLg,
  Tag01,
  Users01,
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
import { usePackagePath } from "@/web/components/sections-editor/use-package-path";
import { hasEditableAppEditorSchema } from "./app-editor-schema";
import { type LiveMeta } from "@/web/components/sections-editor/resolve-schema";
import { useSaveBlock } from "@/web/components/sections-editor/use-save-block";
import { useDeleteBlock } from "@/web/components/sections-editor/use-delete-block";
import {
  extractGlobalSections,
  extractPages,
  findSiteAppEntry,
  hasEditableDecoContent,
  type GlobalSectionEntry,
  type PageEntry,
} from "@/web/components/sections-editor/page-list";
import type { AppCatalogEntry } from "./app-catalog";
import { ListEmpty } from "./list-empty";
import { useDecoAppsCatalog } from "@/web/hooks/use-deco-apps-catalog";
import { normalizePagePath } from "@/web/components/sections-editor/page-path-utils";
import {
  appendPageVariantSections,
  getPageVariantCount,
  getPageVariantSectionsAt,
} from "@/web/components/sections-editor/page-variants";
import { listAvailableSections } from "@/web/components/sections-editor/section-catalog";
import { createReferencedBlockSaver } from "@/web/components/sections-editor/save-referenced-block";
import { CollectionsSidebar } from "./collections-sidebar";
import { useSandboxEvents } from "@/web/components/sandbox/hooks/use-sandbox-events";
import {
  sandboxUserStop,
  useSandboxStart,
  type SandboxStartArgs,
} from "@/web/components/sandbox/hooks/use-sandbox-start";
import { computePreviewState } from "@/web/components/sandbox/preview/preview-state";
import { decodeSandboxStartError } from "@/shared/sandbox-start-errors";
import { SandboxStateRenderer } from "./sandbox-state-renderer";
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
import {
  buildRedirectBlock,
  extractRedirects,
  generateRedirectBlockKey,
  type RedirectEntry,
} from "./redirect-data";
import { RedirectTypeBadge } from "./redirect-type-badge";
import {
  type BlogEntry,
  type BlogKind,
  type CategoryRef,
  addCategoryToPost,
  BLOG_KINDS,
  BLOG_SINGULAR,
  buildBlogBlock,
  emptyBlogPayload,
  generateBlogKey,
  getBlogPayload,
  isBlogKind,
  listBlogPayloads,
  listPostsWithMeta,
  removeCategoryFromPost,
  replaceCategoryOnPost,
  scanBlogEntries,
  stampPostModified,
} from "./blog/blog-data";
import {
  useDeleteBlogBlock,
  useSaveBlogBlock,
} from "./blog/use-blog-mutations";
import { PageJsonDialog } from "@/web/components/sections-editor/page-json-dialog";
import { RunnableBlocksBrowser } from "./runnable-blocks-browser";
import { countAvailableRunnables } from "./runnable-catalog";
import { EmptyMessage } from "./empty-message";
import { SectionsRightPane } from "./sections-right-pane";
import { PostFilterBar, PostSelectionToolbar } from "./post-toolbar";
import { ItemActions } from "./item-actions";
import { ItemRow } from "./item-row";
import {
  GroupHeader,
  groupSavedSectionsByResolveType,
} from "./section-group-header";
import { useBlocksPreviewWorkspace } from "@/web/components/sandbox/blocks/blocks-preview-workspace-context";
import type { BlocksTarget } from "@/web/components/sandbox/blocks/blocks-preview-workspace-state";

const AppEditor = lazy(() =>
  import("./app-editor").then((m) => ({ default: m.AppEditor })),
);

const PostEditor = lazy(() =>
  import("./blog/post-editor").then((m) => ({ default: m.PostEditor })),
);

const RecordEditor = lazy(() =>
  import("./blog/record-editor").then((m) => ({ default: m.RecordEditor })),
);

const CategoryEditor = lazy(() =>
  import("./blog/category-editor").then((m) => ({ default: m.CategoryEditor })),
);

const BulkCategoryPanel = lazy(() =>
  import("./blog/bulk-category-panel").then((m) => ({
    default: m.BulkCategoryPanel,
  })),
);

const SectionsEditor = lazy(() =>
  import("@/web/components/sections-editor/sections-editor").then((m) => ({
    default: m.SectionsEditor,
  })),
);

const SeoEditor = lazy(() =>
  import("@/web/components/sections-editor/seo-editor").then((m) => ({
    default: m.SeoEditor,
  })),
);

const VariantCalendar = lazy(() =>
  import("./variant-calendar/variant-calendar").then((m) => ({
    default: m.VariantCalendar,
  })),
);

const RedirectEditor = lazy(() =>
  import("./redirect-editor").then((m) => ({ default: m.RedirectEditor })),
);

export type CollectionId =
  | "pages"
  | "sections"
  | "apps"
  | "site"
  | "seo"
  | "calendar"
  | "loaders"
  | "actions"
  | "redirects"
  | BlogKind;

export type CollectionCounts = Record<
  | "pages"
  | "sections"
  | "apps"
  | "loaders"
  | "actions"
  | "redirects"
  | "posts"
  | "authors"
  | "categories",
  number
>;

type Selection =
  | { collection: "pages"; key: string; path: string }
  | { collection: "sections"; key: string }
  | {
      collection: "available-section";
      resolveType: string;
      title: string;
    }
  | { collection: "apps"; key: string }
  | { collection: "redirects"; key: string }
  | { collection: BlogKind; key: string }
  | null;

function selectionFromBlocksTarget(target: BlocksTarget | null): Selection {
  if (!target) return null;
  return target.kind === "page"
    ? { collection: "pages", key: target.key, path: target.path }
    : { collection: "sections", key: target.key };
}

function blocksTargetKey(target: BlocksTarget | null): string | null {
  if (!target) return null;
  return target.kind === "page"
    ? `page:${target.key}:${target.path}`
    : `section:${target.key}`;
}

/** A raw manifest section the user can customize and save as a global block. */
export interface AvailableSectionEntry {
  resolveType: string;
  title: string;
  description?: string;
}

type PageDialogState = {
  mode: PageFormMode;
  sourceKey: string | null; // null for "create"
  initialName: string;
  initialPath: string;
} | null;

type DeleteTarget =
  | { kind: "page"; key: string; label: string }
  | { kind: "section"; key: string; label: string }
  | { kind: "redirect"; key: string; label: string }
  | { kind: "blog"; blogKind: BlogKind; key: string; label: string }
  | { kind: "blog-bulk"; keys: string[]; count: number }
  | null;

export type PostSort = "date-desc" | "date-asc" | "az" | "za";

export interface ContentBrowserProps {
  mode?: "content" | "blocks";
}

export function ContentBrowser({ mode = "content" }: ContentBrowserProps) {
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

  const mcpClient = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: inset?.entity?.organization_id ?? "",
    orgSlug: org.slug,
  });
  const startVm = useSandboxStart(mcpClient);

  const triggerStart = () => {
    if (!virtualMcpId) return;
    const args: SandboxStartArgs = { virtualMcpId };
    if (branch) args.branch = branch;
    startVm.mutate(args);
  };

  // Mirror Preview's state machine so both tabs agree on what the
  // sandbox is doing. Without this Content would always show "starting"
  // even when the sandbox is suspended.
  const userStopped =
    !!virtualMcpId &&
    !!branch &&
    sandboxUserStop.isStopped(virtualMcpId, branch);
  const sandboxState = computePreviewState({
    previewUrl,
    appPaused: vmEvents.status.state === "paused",
    userStopped,
    startError:
      startVm.isError && startVm.error
        ? decodeSandboxStartError(startVm.error.message)
        : null,
  });

  if (sandboxState.kind !== "iframe") {
    return (
      <SandboxStateRenderer
        state={sandboxState}
        claimPhase={vmEvents.phase}
        lifecycle={vmEvents.lifecycle}
        onStart={triggerStart}
        connectionsHref={`/${org.slug}/settings/connections`}
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
      mode={mode}
      devServerReady={vmEvents.lifecycle.phase === "running"}
    />
  );
}

const SCHEMA_POLL_INTERVAL_MS = 2000;
const SCHEMA_POLL_MAX_ATTEMPTS = 15;

function liveMetaSchemaPollIntervalMs(
  query: Query<LiveMeta>,
  resolveType: string | undefined,
  meta: LiveMeta | undefined,
  excludeFields?: readonly string[],
): number | false {
  if (typeof resolveType !== "string") return false;
  if (!meta) return SCHEMA_POLL_INTERVAL_MS;
  if (hasEditableAppEditorSchema(resolveType, meta, excludeFields)) {
    return false;
  }
  if (query.state.dataUpdateCount >= SCHEMA_POLL_MAX_ATTEMPTS) return false;
  return SCHEMA_POLL_INTERVAL_MS;
}

function ContentBrowserReady({
  orgSlug,
  virtualMcpId,
  branch,
  previewUrl,
  mode,
  devServerReady,
}: {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
  previewUrl: string | null;
  mode: "content" | "blocks";
  devServerReady: boolean;
}) {
  const workspace = useBlocksPreviewWorkspace();
  const fetchParams = { orgSlug, virtualMcpId, branch, previewUrl };
  const packagePath = usePackagePath(virtualMcpId);
  const { data: decofile, isLoading: decofileLoading } = useDecofile(
    fetchParams,
    { fetchEnabled: devServerReady },
  );

  const [activeCollection, setActiveCollection] =
    useState<CollectionId>("pages");
  const [selection, setSelection] = useState<Selection>(() =>
    mode === "blocks"
      ? selectionFromBlocksTarget(workspace.state.target)
      : null,
  );
  // Page that should open with the inline SEO form in SectionsEditor.
  const [openPageSeoKey, setOpenPageSeoKey] = useState<string | null>(() =>
    mode === "blocks" ? workspace.state.editSeoPageKey : null,
  );
  const currentWorkspaceTargetKey = blocksTargetKey(workspace.state.target);
  const [handledWorkspaceTargetKey, setHandledWorkspaceTargetKey] = useState(
    currentWorkspaceTargetKey,
  );
  if (
    mode === "blocks" &&
    handledWorkspaceTargetKey !== currentWorkspaceTargetKey
  ) {
    setHandledWorkspaceTargetKey(currentWorkspaceTargetKey);
    const next = selectionFromBlocksTarget(workspace.state.target);
    setSelection(next);
    if (next?.collection === "pages" || next?.collection === "sections") {
      setActiveCollection(next.collection);
    }
  }
  const [handledSeoPageKey, setHandledSeoPageKey] = useState(
    workspace.state.editSeoPageKey,
  );
  if (
    mode === "blocks" &&
    handledSeoPageKey !== workspace.state.editSeoPageKey
  ) {
    setHandledSeoPageKey(workspace.state.editSeoPageKey);
    if (workspace.state.editSeoPageKey) {
      const target = workspace.state.target;
      if (target?.kind === "page") {
        setActiveCollection("pages");
        setSelection(selectionFromBlocksTarget(target));
        setOpenPageSeoKey(target.key);
      }
    }
  }
  const [searchQuery, setSearchQuery] = useState("");
  // Posts-only filter/sort + bulk selection state.
  const [postCategoryFilter, setPostCategoryFilter] = useState<string | null>(
    null,
  );
  const [postAuthorFilter, setPostAuthorFilter] = useState<string | null>(null);
  const [postSort, setPostSort] = useState<PostSort>("date-desc");
  const [selectedPostKeys, setSelectedPostKeys] = useState<Set<string>>(
    () => new Set(),
  );
  // Category slug that pre-opens the bulk "Update category" panel (set when
  // arriving from a category's "Add posts" / "Manage posts" action). While
  // non-null the panel stays open even with zero posts selected.
  const [bulkCategorySeed, setBulkCategorySeed] = useState<string | null>(null);
  // Multi-select is implicit: selecting the first post (via the hover-revealed
  // checkbox) enters "selection mode". Closing the panel (or applying) leaves
  // it and drops the seed.
  const clearSelection = () => {
    setSelectedPostKeys(new Set());
    setBulkCategorySeed(null);
  };
  const selectItem = (next: Selection) => {
    setSelection(next);
    setOpenPageSeoKey(null);
    if (mode !== "blocks" || !next) return;
    if (next.collection === "pages") {
      workspace.selectTarget({
        kind: "page",
        key: next.key,
        path: next.path,
      });
    } else if (next.collection === "sections") {
      workspace.selectTarget({ kind: "section", key: next.key });
    }
  };
  // Reset search + post filters/selection when switching collections
  // (derived-state sync pattern).
  const [prevCollection, setPrevCollection] = useState(activeCollection);
  if (prevCollection !== activeCollection) {
    setPrevCollection(activeCollection);
    setSearchQuery("");
    setPostCategoryFilter(null);
    setPostAuthorFilter(null);
    setPostSort("date-desc");
    setSelectedPostKeys(new Set());
    setBulkCategorySeed(null);
  }

  const {
    data: meta,
    isLoading: metaLoading,
    isFetching: metaFetching,
  } = useLiveMeta(fetchParams, {
    fetchEnabled: devServerReady,
    refetchInterval: (query) => {
      const currentMeta = query.state.data;

      if (
        activeCollection === "apps" &&
        selection &&
        selection.collection === "apps"
      ) {
        const block = decofile?.[selection.key] as
          | Record<string, unknown>
          | undefined;
        return liveMetaSchemaPollIntervalMs(
          query,
          typeof block?.__resolveType === "string"
            ? block.__resolveType
            : undefined,
          currentMeta,
        );
      }

      if (activeCollection === "site" && decofile) {
        const siteEntry = currentMeta
          ? findSiteAppEntry(decofile, currentMeta)
          : null;
        const siteBlock = decofile.site as Record<string, unknown> | undefined;
        const resolveType =
          siteEntry?.resolveType ??
          (typeof siteBlock?.__resolveType === "string"
            ? siteBlock.__resolveType
            : undefined);
        return liveMetaSchemaPollIntervalMs(query, resolveType, currentMeta, [
          "seo",
        ]);
      }

      return false;
    },
  });

  const isAppSchemaLoading = (
    resolveType: string | undefined,
    excludeFields?: readonly string[],
  ) =>
    !hasEditableAppEditorSchema(resolveType, meta, excludeFields) &&
    (metaLoading || metaFetching);

  const { catalog: appCatalog, isLoading: appCatalogLoading } =
    useDecoAppsCatalog(meta ?? undefined, decofile ?? undefined, {
      enabled: activeCollection === "apps",
    });

  const saveBlock = useSaveBlock(fetchParams);
  const deleteBlock = useDeleteBlock(fetchParams);
  const saveBlogBlock = useSaveBlogBlock({ ...fetchParams, packagePath });
  const deleteBlogBlock = useDeleteBlogBlock({ ...fetchParams, packagePath });

  // Dialog state
  const [pageDialog, setPageDialog] = useState<PageDialogState>(null);
  const [pageDialogError, setPageDialogError] = useState<string | undefined>();
  const [renameSectionKey, setRenameSectionKey] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget>(null);
  const [jsonPageKey, setJsonPageKey] = useState<string | null>(null);

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
  const redirects = extractRedirects(decofile).sort((a, b) =>
    a.from.localeCompare(b.from),
  );
  const globalSections = extractGlobalSections(decofile, meta);
  // Only the Sections tab needs the raw catalog. Use the cheap lister (labels
  // only, no per-section schema resolution) — resolving every section's schema
  // here froze the tab on sites with many sections.
  const availableSections: AvailableSectionEntry[] =
    activeCollection === "sections" ? listAvailableSections(meta) : [];
  const siteApp = findSiteAppEntry(decofile, meta);
  const allBlogEntries = scanBlogEntries(decofile);
  const showBlog = BLOG_KINDS.some((k) => allBlogEntries[k].length > 0);
  const blogEntries = isBlogKind(activeCollection)
    ? allBlogEntries[activeCollection]
    : [];

  // Category choices for the bulk "Update category" panel (parent scope, since
  // the panel renders in the right pane rather than inside ItemList).
  const bulkCategoryChoices: CategoryRef[] = (
    showBlog ? listBlogPayloads(decofile, "categories") : []
  )
    .map(({ key, payload }) => {
      const slug = typeof payload.slug === "string" ? payload.slug : "";
      const name = typeof payload.name === "string" ? payload.name : "";
      return { slug: slug || key, name: name || slug || key };
    })
    .filter((c) => c.slug)
    .sort((a, b) => a.name.localeCompare(b.name));

  // The bulk "Update category" panel shows while posts are selected, or while
  // a category seed forces it open (arriving from the category editor).
  const bulkPanelOpen =
    activeCollection === "posts" &&
    (selectedPostKeys.size > 0 || bulkCategorySeed !== null);
  // Posts the panel will act on (selection order is irrelevant — list order
  // mirrors the decofile scan, same as the list pane).
  const selectedPostsMeta = bulkPanelOpen
    ? listPostsWithMeta(decofile).filter((p) => selectedPostKeys.has(p.key))
    : [];

  const loadersCount = countAvailableRunnables(meta, "loaders");
  const actionsCount = countAvailableRunnables(meta, "actions");

  // Loader/action-only sites are still editable — don't gate them out.
  if (
    !hasEditableDecoContent(decofile, meta) &&
    !showBlog &&
    loadersCount === 0 &&
    actionsCount === 0
  ) {
    return (
      <EmptyMessage
        icon={AlertCircle}
        title="No editable content"
        description="This project doesn't expose any Deco pages, sections, apps, loaders, or actions."
      />
    );
  }

  const counts: CollectionCounts = {
    pages: pages.length,
    sections: globalSections.length,
    apps: appCatalog.length,
    loaders: loadersCount,
    actions: actionsCount,
    redirects: redirects.length,
    posts: allBlogEntries.posts.length,
    authors: allBlogEntries.authors.length,
    categories: allBlogEntries.categories.length,
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

  const submitPageDialog = async (values: {
    name: string;
    path: string;
    templateKey: string | null;
  }) => {
    if (!pageDialog) return;
    const { mode, sourceKey } = pageDialog;
    try {
      if (mode === "create") {
        // A template clones an existing page's content; only name/path change.
        let data: Record<string, unknown>;
        if (values.templateKey) {
          const template = decofile[values.templateKey] as
            | Record<string, unknown>
            | undefined;
          if (!template) throw new Error("Selected template no longer exists.");
          data = { ...template, name: values.name, path: values.path };
        } else {
          data = buildEmptyPage(values.name, values.path);
        }
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
  // Persist an edited available (raw manifest) section as a new global block.
  // `blockId` becomes both the decofile key and the `name`; the form data is
  // merged in. Throws on failure so the editor keeps its name dialog open.
  const handleCreateAvailableSection = async (
    resolveType: string,
    blockId: string,
    formValue: Record<string, unknown>,
  ) => {
    await saveBlock.mutateAsync({
      blockKey: blockId,
      data: { ...formValue, name: blockId, __resolveType: resolveType },
    });
    toast.success(`Created section "${blockId}"`);
    setSelection({ collection: "sections", key: blockId });
  };

  // Persist nested saved-block references created from within the section form.
  const saveReferencedBlock = createReferencedBlockSaver((blockKey, data) =>
    saveBlock.mutate({ blockKey, data }),
  );

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

  // ------------------ Redirect CRUD ------------------
  // Redirects are standalone `website/loaders/redirect.ts` blocks; the site's
  // routes auto-discover them, so create/delete is a plain block write.
  const handleCreateRedirect = async () => {
    // Seed non-empty placeholder paths so the new block is a valid redirect
    // (never an empty from/to that would emit a broken route once published).
    const from = "/redirect-from";
    const key = generateRedirectBlockKey(decofile, from);
    const data = buildRedirectBlock({
      from,
      to: "/redirect-to",
      type: "temporary",
      discardQueryParameters: false,
    });
    try {
      await saveBlock.mutateAsync({ blockKey: key, data });
      toast.success("Created redirect");
      setSelection({ collection: "redirects", key });
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not create redirect",
      );
    }
  };

  // ------------------ Blog CRUD ------------------
  const handleCreateBlog = async (kind: BlogKind) => {
    const key = generateBlogKey(decofile, kind);
    const data = buildBlogBlock(key, kind, emptyBlogPayload(kind));
    try {
      await saveBlogBlock.mutateAsync({ blockKey: key, data });
      toast.success(`Created ${BLOG_SINGULAR[kind]}`);
      setSelection({ collection: kind, key });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not create");
    }
  };

  const handleDuplicateBlog = async (entry: BlogEntry) => {
    const source = decofile[entry.key] as Record<string, unknown> | undefined;
    if (!source) {
      toast.error("Record not found.");
      return;
    }
    const key = generateBlogKey(decofile, entry.kind);
    const labelKey = entry.kind === "posts" ? "title" : "name";
    const payload = {
      ...structuredClone(getBlogPayload(source, entry.kind)),
      [labelKey]: `${entry.label} (copy)`,
    };
    try {
      await saveBlogBlock.mutateAsync({
        blockKey: key,
        data: buildBlogBlock(key, entry.kind, payload),
      });
      toast.success(`Duplicated "${entry.label}"`);
      setSelection({ collection: entry.kind, key });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Duplicate failed");
    }
  };

  // ------------------ Posts: filter jump + bulk actions ------------------
  const togglePostSelection = (key: string) => {
    setSelectedPostKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  // Land on the unfiltered posts list with the bulk "Update category" panel
  // already open and the clicked category pre-selected (from the category
  // editor's "Add posts" / "Manage posts" actions). Sync `prevCollection` here
  // so the collection-change reset above doesn't immediately clear what we're
  // setting.
  const handleManagePosts = (slug: string) => {
    setActiveCollection("posts");
    setPrevCollection("posts");
    setSelection(null);
    setOpenPageSeoKey(null);
    setSearchQuery("");
    setPostCategoryFilter(null);
    setPostAuthorFilter(null);
    setPostSort("date-desc");
    setSelectedPostKeys(new Set());
    setBulkCategorySeed(slug || null);
  };

  // Apply a pure category mutation to every selected post and persist
  // sequentially — each mutation's optimistic onMutate patches the shared
  // decofile cache key, so sequential writes avoid lost updates. The mutation
  // helpers return the SAME payload object on a no-op, so reference equality
  // tells us which posts actually changed. Returns the changed count.
  const applyBulkCategory = async (
    mode: "add" | "replace",
    category: CategoryRef,
  ): Promise<number> => {
    const keys = [...selectedPostKeys];
    let changed = 0;
    for (const key of keys) {
      const block = decofile[key] as Record<string, unknown> | undefined;
      const payload = getBlogPayload(block, "posts");
      const next =
        mode === "add"
          ? addCategoryToPost(payload, category)
          : replaceCategoryOnPost(payload, category);
      if (next === payload) continue;
      await saveBlogBlock.mutateAsync({
        blockKey: key,
        data: buildBlogBlock(key, "posts", stampPostModified(next)),
      });
      changed += 1;
    }
    return changed;
  };

  // Driven by the "Update category" panel: applies the chosen mode, reports
  // the outcome, then clears the selection (which closes the panel).
  const runBulkCategoryUpdate = async (
    mode: "add" | "replace",
    category: CategoryRef,
  ) => {
    const total = selectedPostKeys.size;
    try {
      const changed = await applyBulkCategory(mode, category);
      const verb = mode === "add" ? "Added to" : "Moved";
      const unchanged = total - changed;
      toast.success(
        `${verb} ${changed} ${changed === 1 ? "post" : "posts"}` +
          (unchanged > 0 ? ` (${unchanged} already set)` : ""),
      );
      clearSelection();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Bulk update failed");
    }
  };

  // ------------------ Delete ------------------
  const confirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      if (deleteTarget.kind === "blog-bulk") {
        for (const key of deleteTarget.keys) {
          await deleteBlogBlock.mutateAsync({ blockKey: key });
        }
        toast.success(
          `Deleted ${deleteTarget.count} ${
            deleteTarget.count === 1 ? "post" : "posts"
          }`,
        );
        if (
          selection &&
          selection.collection !== "available-section" &&
          deleteTarget.keys.includes(selection.key)
        ) {
          setSelection(null);
        }
        clearSelection();
        setDeleteTarget(null);
        return;
      }
      const { kind, key, label } = deleteTarget;
      if (kind === "blog") {
        // Deleting a category cascades to posts: they carry a denormalized
        // copy of the category slug, so drop it everywhere first — otherwise
        // posts keep a reference to a category that no longer exists. Posts
        // first, then the category, so a failed cascade leaves it recoverable.
        if (deleteTarget.blogKind === "categories") {
          const slugValue = getBlogPayload(
            decofile[key] as Record<string, unknown> | undefined,
            "categories",
          ).slug;
          const slug = typeof slugValue === "string" ? slugValue : "";
          if (slug) {
            for (const { key: postKey, payload } of listBlogPayloads(
              decofile,
              "posts",
            )) {
              const next = removeCategoryFromPost(payload, slug);
              if (next === payload) continue;
              await saveBlogBlock.mutateAsync({
                blockKey: postKey,
                data: buildBlogBlock(postKey, "posts", stampPostModified(next)),
              });
            }
          }
        }
        await deleteBlogBlock.mutateAsync({ blockKey: key });
      } else {
        await deleteBlock.mutateAsync({ blockKey: key });
      }
      toast.success(`Deleted "${label}"`);
      if (
        selection &&
        selection.collection !== "available-section" &&
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
  // `saveBlogBlock.isPending` covers the category-delete cascade (posts are
  // rewritten via saveBlogBlock BEFORE the category block is unlinked), so the
  // confirm dialog stays locked for the whole operation instead of only its
  // final unlink — otherwise it could be re-clicked or dismissed mid-cascade.
  const isDeleting =
    deleteBlock.isPending ||
    deleteBlogBlock.isPending ||
    saveBlogBlock.isPending;
  const deleteNoun =
    deleteTarget?.kind === "blog"
      ? BLOG_SINGULAR[deleteTarget.blogKind]
      : deleteTarget?.kind === "blog-bulk"
        ? `${deleteTarget.count} ${deleteTarget.count === 1 ? "post" : "posts"}`
        : (deleteTarget?.kind ?? "item");
  return (
    <div className="flex h-full w-full">
      {mode === "content" && (
        <CollectionsSidebar
          active={activeCollection}
          counts={counts}
          showBlog={showBlog}
          onSelect={(id) => {
            setActiveCollection(id);
            setSelection(null);
            setOpenPageSeoKey(null);
          }}
        />
      )}
      {activeCollection !== "seo" &&
        activeCollection !== "site" &&
        activeCollection !== "calendar" &&
        activeCollection !== "loaders" &&
        activeCollection !== "actions" && (
          <ItemList
            blocksMode={mode === "blocks"}
            activeCollection={activeCollection}
            pages={pages}
            redirects={redirects}
            sections={globalSections}
            availableSections={availableSections}
            appCatalog={appCatalog}
            appCatalogLoading={appCatalogLoading}
            blogEntries={blogEntries}
            decofile={decofile}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            postCategoryFilter={postCategoryFilter}
            postAuthorFilter={postAuthorFilter}
            postSort={postSort}
            onPostCategoryFilterChange={(slug) => {
              setPostCategoryFilter(slug);
              setSelectedPostKeys(new Set());
            }}
            onPostAuthorFilterChange={(email) => {
              setPostAuthorFilter(email);
              setSelectedPostKeys(new Set());
            }}
            onPostSortChange={setPostSort}
            selectedPostKeys={selectedPostKeys}
            postBulkPanelOpen={bulkPanelOpen}
            onTogglePostSelect={togglePostSelection}
            onSelectAllPosts={(keys) => setSelectedPostKeys(new Set(keys))}
            onClearPostSelection={() => setSelectedPostKeys(new Set())}
            onExitPostSelection={clearSelection}
            onBulkDeletePosts={() =>
              setDeleteTarget({
                kind: "blog-bulk",
                keys: [...selectedPostKeys],
                count: selectedPostKeys.size,
              })
            }
            selection={selection}
            onSelect={selectItem}
            onCollectionSelect={(collection) => {
              setActiveCollection(collection);
              setSelection(null);
              setOpenPageSeoKey(null);
            }}
            onCreate={() => {
              if (activeCollection === "pages") {
                openCreatePage();
              } else if (activeCollection === "redirects") {
                void handleCreateRedirect();
              } else if (isBlogKind(activeCollection)) {
                void handleCreateBlog(activeCollection);
              }
            }}
            onDuplicatePage={openDuplicatePage}
            onRenamePage={openRenamePage}
            onAddPageVariant={handleAddPageVariant}
            onDeletePage={(page) =>
              setDeleteTarget({ kind: "page", key: page.key, label: page.name })
            }
            onEditPageSeo={(page) => {
              const target = {
                collection: "pages",
                key: page.key,
                path: page.path,
              } as const;
              setSelection(target);
              setOpenPageSeoKey(page.key);
              if (mode === "blocks") {
                workspace.editSeo({
                  kind: "page",
                  key: page.key,
                  path: page.path,
                });
              }
            }}
            onViewPageJson={(page) => setJsonPageKey(page.key)}
            onDuplicateSection={handleDuplicateSection}
            onRenameSection={(s) => setRenameSectionKey(s.key)}
            onDeleteSection={(s) =>
              setDeleteTarget({ kind: "section", key: s.key, label: s.name })
            }
            onDeleteRedirect={(entry) =>
              setDeleteTarget({
                kind: "redirect",
                key: entry.key,
                label: entry.from || entry.key,
              })
            }
            onDuplicateBlog={handleDuplicateBlog}
            onDeleteBlog={(e) =>
              setDeleteTarget({
                kind: "blog",
                blogKind: e.kind,
                key: e.key,
                label: e.label,
              })
            }
          />
        )}
      <div className="flex-1 min-w-0">
        {activeCollection === "loaders" || activeCollection === "actions" ? (
          <RunnableBlocksBrowser
            orgSlug={orgSlug}
            virtualMcpId={virtualMcpId}
            branch={branch}
            previewUrl={previewUrl}
            meta={meta}
            decofile={decofile}
            kind={activeCollection}
          />
        ) : (
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
            {activeCollection === "calendar" ? (
              <VariantCalendar decofile={decofile} />
            ) : activeCollection === "site" ? (
              siteApp ? (
                <AppEditor
                  key={`site:${siteApp.key}`}
                  orgSlug={orgSlug}
                  virtualMcpId={virtualMcpId}
                  branch={branch}
                  blockKey={siteApp.key}
                  block={decofile[siteApp.key] as Record<string, unknown>}
                  decofile={decofile}
                  meta={meta}
                  title="Site"
                  excludeFields={["seo"]}
                  schemaPending={isAppSchemaLoading(siteApp.resolveType, [
                    "seo",
                  ])}
                  previewBaseUrl={previewUrl}
                />
              ) : (
                <EmptyMessage
                  title="Site settings not found"
                  description="This project doesn't have a site app block (site/apps/site.ts)."
                />
              )
            ) : activeCollection === "seo" ? (
              <SeoEditor
                orgSlug={orgSlug}
                virtualMcpId={virtualMcpId}
                branch={branch}
                decofile={decofile}
                meta={meta}
                target={{ kind: "site" }}
                previewBaseUrl={previewUrl}
              />
            ) : activeCollection === "sections" ? (
              <SectionsRightPane
                selection={
                  selection?.collection === "sections" ||
                  selection?.collection === "available-section"
                    ? selection
                    : null
                }
                orgSlug={orgSlug}
                virtualMcpId={virtualMcpId}
                branch={branch}
                previewUrl={previewUrl}
                meta={meta}
                decofile={decofile}
                isCreating={saveBlock.isPending}
                onCreateAvailable={handleCreateAvailableSection}
                onSaveReferencedBlock={saveReferencedBlock}
              />
            ) : bulkPanelOpen ? (
              // Posts selection mode: the bulk "Update category" panel takes
              // over the right pane (rows toggle selection, not the editor).
              // Keyed by seed so arriving from a category remounts the panel
              // with that category pre-selected.
              <BulkCategoryPanel
                key={bulkCategorySeed ?? "selection"}
                posts={selectedPostsMeta}
                categories={bulkCategoryChoices}
                initialSlug={bulkCategorySeed}
                isPending={saveBlogBlock.isPending}
                onApply={(mode, category) =>
                  void runBulkCategoryUpdate(mode, category)
                }
                onClose={clearSelection}
              />
            ) : selection && selection.collection !== "available-section" ? (
              selection.collection === "apps" ? (
                <AppEditor
                  key={`app:${selection.key}`}
                  orgSlug={orgSlug}
                  virtualMcpId={virtualMcpId}
                  branch={branch}
                  blockKey={selection.key}
                  block={decofile[selection.key] as Record<string, unknown>}
                  decofile={decofile}
                  meta={meta}
                  previewBaseUrl={previewUrl}
                  schemaPending={isAppSchemaLoading(
                    typeof (decofile[selection.key] as Record<string, unknown>)
                      ?.__resolveType === "string"
                      ? String(
                          (decofile[selection.key] as Record<string, unknown>)
                            .__resolveType,
                        )
                      : undefined,
                  )}
                />
              ) : selection.collection === "posts" ? (
                <PostEditor
                  key={`post:${selection.key}`}
                  orgSlug={orgSlug}
                  virtualMcpId={virtualMcpId}
                  branch={branch}
                  blockKey={selection.key}
                  block={decofile[selection.key] as Record<string, unknown>}
                  decofile={decofile}
                  meta={meta}
                  previewBaseUrl={previewUrl}
                />
              ) : selection.collection === "categories" ? (
                <CategoryEditor
                  key={`category:${selection.key}`}
                  orgSlug={orgSlug}
                  virtualMcpId={virtualMcpId}
                  branch={branch}
                  blockKey={selection.key}
                  block={decofile[selection.key] as Record<string, unknown>}
                  decofile={decofile}
                  meta={meta}
                  onManagePosts={handleManagePosts}
                  onOpenPost={(key) => {
                    setActiveCollection("posts");
                    setPrevCollection("posts");
                    setSelection({ collection: "posts", key });
                    setOpenPageSeoKey(null);
                  }}
                  previewBaseUrl={previewUrl}
                />
              ) : selection.collection === "authors" ? (
                <RecordEditor
                  key={`authors:${selection.key}`}
                  orgSlug={orgSlug}
                  virtualMcpId={virtualMcpId}
                  branch={branch}
                  kind="authors"
                  blockKey={selection.key}
                  block={decofile[selection.key] as Record<string, unknown>}
                />
              ) : selection.collection === "redirects" ? (
                <RedirectEditor
                  key={`redirect:${selection.key}`}
                  orgSlug={orgSlug}
                  virtualMcpId={virtualMcpId}
                  branch={branch}
                  blockKey={selection.key}
                  block={decofile[selection.key] as Record<string, unknown>}
                />
              ) : (
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
                  initialEditSeo={
                    selection.collection === "pages" &&
                    openPageSeoKey === selection.key
                  }
                  onExitSeo={() => {
                    setOpenPageSeoKey(null);
                    if (mode === "blocks") workspace.consumeEditSeo();
                  }}
                />
              )
            ) : (
              <EmptyMessage
                title={`Select ${
                  isBlogKind(activeCollection)
                    ? `a ${BLOG_SINGULAR[activeCollection]}`
                    : activeCollection === "pages"
                      ? "a page"
                      : activeCollection === "apps"
                        ? "an app"
                        : activeCollection === "redirects"
                          ? "a redirect"
                          : "a section"
                } to edit`}
                description={
                  activeCollection === "apps"
                    ? "Browse all apps and select an installed one to edit its settings."
                    : 'Pick an item from the list, or click "+" to create one.'
                }
              />
            )}
          </Suspense>
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
          templates={pages}
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

      {/* Page JSON dialog */}
      {jsonPageKey && (
        <PageJsonDialog
          open={!!jsonPageKey}
          onOpenChange={(open) => {
            if (!open) setJsonPageKey(null);
          }}
          pageKey={jsonPageKey}
          decofile={decofile}
          onSave={(data) =>
            saveBlock.mutateAsync({ blockKey: jsonPageKey, data })
          }
        />
      )}

      {/* Delete confirmation */}
      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(next) => {
          if (!next && !isDeleting) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{`Delete ${deleteNoun}?`}</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget?.kind === "section"
                ? `"${deleteTarget.label}" will be removed. Pages that still reference it will lose this section.`
                : deleteTarget?.kind === "blog-bulk"
                  ? `${deleteTarget.count} ${
                      deleteTarget.count === 1 ? "post" : "posts"
                    } will be removed permanently. This can't be undone.`
                  : deleteTarget
                    ? `"${deleteTarget.label}" will be removed permanently. This can't be undone.`
                    : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void confirmDelete();
              }}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting ? (
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

function ItemList({
  blocksMode,
  activeCollection,
  pages,
  redirects,
  sections,
  availableSections,
  appCatalog,
  appCatalogLoading,
  blogEntries,
  decofile,
  searchQuery,
  onSearchChange,
  postCategoryFilter,
  postAuthorFilter,
  postSort,
  onPostCategoryFilterChange,
  onPostAuthorFilterChange,
  onPostSortChange,
  selectedPostKeys,
  postBulkPanelOpen,
  onTogglePostSelect,
  onSelectAllPosts,
  onClearPostSelection,
  onExitPostSelection,
  onBulkDeletePosts,
  selection,
  onSelect,
  onCollectionSelect,
  onCreate,
  onDuplicatePage,
  onRenamePage,
  onAddPageVariant,
  onDeletePage,
  onEditPageSeo,
  onViewPageJson,
  onDuplicateSection,
  onRenameSection,
  onDeleteSection,
  onDeleteRedirect,
  onDuplicateBlog,
  onDeleteBlog,
}: {
  blocksMode: boolean;
  activeCollection: CollectionId;
  pages: PageEntry[];
  redirects: RedirectEntry[];
  sections: GlobalSectionEntry[];
  availableSections: AvailableSectionEntry[];
  appCatalog: AppCatalogEntry[];
  appCatalogLoading: boolean;
  blogEntries: BlogEntry[];
  decofile: Record<string, unknown>;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  postCategoryFilter: string | null;
  postAuthorFilter: string | null;
  postSort: PostSort;
  onPostCategoryFilterChange: (slug: string | null) => void;
  onPostAuthorFilterChange: (email: string | null) => void;
  onPostSortChange: (sort: PostSort) => void;
  selectedPostKeys: Set<string>;
  /** The right-pane bulk panel is open (forces selection mode in the list). */
  postBulkPanelOpen: boolean;
  onTogglePostSelect: (key: string) => void;
  onSelectAllPosts: (keys: string[]) => void;
  /** Deselect all posts, staying in selection mode if the panel is open. */
  onClearPostSelection: () => void;
  /** Leave selection mode entirely (also closes the bulk panel). */
  onExitPostSelection: () => void;
  onBulkDeletePosts: () => void;
  selection: Selection;
  onSelect: (next: Selection) => void;
  onCollectionSelect: (collection: "pages" | "sections") => void;
  onCreate: () => void;
  onDuplicatePage: (page: PageEntry) => void;
  onRenamePage: (page: PageEntry) => void;
  onAddPageVariant: (page: PageEntry) => void;
  onDeletePage: (page: PageEntry) => void;
  onEditPageSeo: (page: PageEntry) => void;
  onViewPageJson: (page: PageEntry) => void;
  onDuplicateSection: (section: GlobalSectionEntry) => void;
  onRenameSection: (section: GlobalSectionEntry) => void;
  onDeleteSection: (section: GlobalSectionEntry) => void;
  onDeleteRedirect: (entry: RedirectEntry) => void;
  onDuplicateBlog: (entry: BlogEntry) => void;
  onDeleteBlog: (entry: BlogEntry) => void;
}) {
  const q = searchQuery.toLowerCase();
  const filteredPages = pages.filter(
    (p) =>
      !q ||
      p.name.toLowerCase().includes(q) ||
      p.path.toLowerCase().includes(q),
  );
  const filteredRedirects = redirects.filter(
    (r) =>
      !q || r.from.toLowerCase().includes(q) || r.to.toLowerCase().includes(q),
  );
  const filteredSections = sections.filter(
    (s) =>
      !q ||
      s.name.toLowerCase().includes(q) ||
      s.key.toLowerCase().includes(q) ||
      s.resolveType.toLowerCase().includes(q),
  );
  const filteredAvailableSections = availableSections.filter(
    (s) =>
      !q ||
      s.title.toLowerCase().includes(q) ||
      s.resolveType.toLowerCase().includes(q) ||
      (s.description?.toLowerCase().includes(q) ?? false),
  );
  // Group saved sections by their underlying resolveType (the section's
  // component), so the list reads as families of the same kind.
  const savedSectionGroups = groupSavedSectionsByResolveType(filteredSections);
  const filteredApps = appCatalog.filter(
    (entry) =>
      !q ||
      entry.title.toLowerCase().includes(q) ||
      entry.app.toLowerCase().includes(q) ||
      entry.vendor.toLowerCase().includes(q) ||
      entry.category.toLowerCase().includes(q),
  );
  const filteredBlog = blogEntries.filter(
    (e) =>
      !q ||
      e.label.toLowerCase().includes(q) ||
      e.subtitle.toLowerCase().includes(q),
  );

  // Posts get their own filter/sort pipeline driven by denormalized
  // category/author metadata, so the plain `blogEntries` path is skipped.
  const isPostsCollection = activeCollection === "posts";
  const asStr = (v: unknown) => (typeof v === "string" ? v : "");
  const postsWithMeta = isPostsCollection ? listPostsWithMeta(decofile) : [];

  // Live counts per category/author so the filter dropdowns can show how
  // many posts each option matches (and hide the ones that match none).
  const categoryCounts = new Map<string, number>();
  const authorCounts = new Map<string, number>();
  for (const p of postsWithMeta) {
    for (const slug of p.categorySlugs) {
      categoryCounts.set(slug, (categoryCounts.get(slug) ?? 0) + 1);
    }
    for (const email of p.authorEmails) {
      authorCounts.set(email, (authorCounts.get(email) ?? 0) + 1);
    }
  }
  const categoryOptions = (
    isPostsCollection ? listBlogPayloads(decofile, "categories") : []
  )
    .map(({ key, payload }) => {
      const slug = asStr(payload.slug) || key;
      return {
        slug,
        name: asStr(payload.name) || asStr(payload.slug) || key,
        count: categoryCounts.get(slug) ?? 0,
      };
    })
    .filter((c) => c.slug);
  const authorOptions = (
    isPostsCollection ? listBlogPayloads(decofile, "authors") : []
  )
    .map(({ key, payload }) => {
      const email = asStr(payload.email);
      return {
        email,
        name: asStr(payload.name) || asStr(payload.email) || key,
        count: authorCounts.get(email) ?? 0,
      };
    })
    .filter((a) => a.email);
  const sortedPosts = postsWithMeta
    .filter(
      (p) =>
        !q ||
        p.title.toLowerCase().includes(q) ||
        p.slug.toLowerCase().includes(q),
    )
    .filter(
      (p) =>
        !postCategoryFilter || p.categorySlugs.includes(postCategoryFilter),
    )
    .filter(
      (p) => !postAuthorFilter || p.authorEmails.includes(postAuthorFilter),
    )
    .sort((a, b) => {
      if (postSort === "az") return a.title.localeCompare(b.title);
      if (postSort === "za") return b.title.localeCompare(a.title);
      // ISO date strings sort lexically; empty dates sink to the bottom.
      const cmp = a.date.localeCompare(b.date);
      return postSort === "date-asc" ? cmp : -cmp;
    });
  const selectionCount = selectedPostKeys.size;
  const visiblePostKeys = sortedPosts.map((p) => p.key);
  const allVisibleSelected =
    visiblePostKeys.length > 0 &&
    visiblePostKeys.every((k) => selectedPostKeys.has(k));
  // Selecting the first post enters "selection mode": the toolbar replaces the
  // filter bar and every row's checkbox becomes visible. The open bulk panel
  // forces it too, so posts can be picked right after landing from a category.
  const selectionActive = selectionCount > 0 || postBulkPanelOpen;
  const toggleSelectAll = () => {
    if (allVisibleSelected) {
      onClearPostSelection();
    } else {
      onSelectAllPosts(visiblePostKeys);
    }
  };

  const placeholder = `Search ${activeCollection}…`;
  const createTooltip = isBlogKind(activeCollection)
    ? `Create new ${BLOG_SINGULAR[activeCollection]}`
    : activeCollection === "redirects"
      ? "Create new redirect"
      : "Create new page";
  // Sections are created by saving an available section, not via the "+".
  const showCreateButton =
    activeCollection !== "apps" && activeCollection !== "sections";

  return (
    <div
      className={cn(
        "shrink-0 border-r flex flex-col min-h-0",
        blocksMode ? "w-[240px]" : "w-[300px]",
      )}
    >
      {blocksMode && (
        <div className="flex h-10 shrink-0 items-center gap-1 border-b px-2">
          <Button
            variant={activeCollection === "pages" ? "secondary" : "ghost"}
            size="sm"
            className="h-7 flex-1"
            onClick={() => onCollectionSelect("pages")}
          >
            <LayoutAlt01 size={14} />
            Pages
          </Button>
          <Button
            variant={activeCollection === "sections" ? "secondary" : "ghost"}
            size="sm"
            className="h-7 flex-1"
            onClick={() => onCollectionSelect("sections")}
          >
            <Globe02 size={14} />
            Sections
          </Button>
        </div>
      )}
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
        {showCreateButton && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={onCreate}
                aria-label={createTooltip}
              >
                <Plus size={14} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{createTooltip}</TooltipContent>
          </Tooltip>
        )}
      </div>
      {isPostsCollection &&
        (selectionActive ? (
          <PostSelectionToolbar
            count={selectionCount}
            allSelected={allVisibleSelected}
            onToggleSelectAll={toggleSelectAll}
            onDelete={onBulkDeletePosts}
            onExit={onExitPostSelection}
          />
        ) : (
          <PostFilterBar
            categories={categoryOptions}
            authors={authorOptions}
            categoryFilter={postCategoryFilter}
            authorFilter={postAuthorFilter}
            sort={postSort}
            onCategoryFilterChange={onPostCategoryFilterChange}
            onAuthorFilterChange={onPostAuthorFilterChange}
            onSortChange={onPostSortChange}
          />
        ))}
      {/* Force Radix's inner `display:table` content wrapper back to block so
          long titles truncate instead of widening the viewport. */}
      <ScrollArea className="flex-1 min-h-0 [&_[data-slot=scroll-area-viewport]>div]:!block">
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
                        onEditSeo={() => onEditPageSeo(page)}
                        onViewJson={() => onViewPageJson(page)}
                        onDelete={() => onDeletePage(page)}
                      />
                    }
                  />
                );
              })
            )
          ) : activeCollection === "sections" ? (
            filteredSections.length === 0 &&
            filteredAvailableSections.length === 0 ? (
              <ListEmpty
                hasItems={sections.length > 0 || availableSections.length > 0}
                emptyLabel="No sections yet."
                emptyHint="Save a section from a page, or start the preview dev server."
              />
            ) : (
              <>
                {savedSectionGroups.length > 0 && (
                  <>
                    <GroupHeader icon={Globe02} label="Saved sections" />
                    {savedSectionGroups.map((group) => (
                      <div key={group.label} className="flex flex-col gap-1">
                        <div className="px-2.5 pt-1 pb-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/60">
                          {group.label}
                        </div>
                        {group.sections.map((section) => {
                          const isActive =
                            selection?.collection === "sections" &&
                            selection.key === section.key;
                          return (
                            <ItemRow
                              key={section.key}
                              icon={Globe02}
                              accent="global"
                              title={section.name}
                              subtitle={group.label}
                              active={isActive}
                              onClick={() =>
                                onSelect({
                                  collection: "sections",
                                  key: section.key,
                                })
                              }
                              menu={
                                <ItemActions
                                  onDuplicate={() =>
                                    onDuplicateSection(section)
                                  }
                                  onRename={() => onRenameSection(section)}
                                  onDelete={() => onDeleteSection(section)}
                                />
                              }
                            />
                          );
                        })}
                      </div>
                    ))}
                  </>
                )}
                {filteredAvailableSections.length > 0 && (
                  <>
                    <GroupHeader
                      icon={LayoutAlt01}
                      label="Available sections"
                      className={cn(savedSectionGroups.length > 0 && "mt-3")}
                    />
                    {filteredAvailableSections.map((section) => {
                      const isActive =
                        selection?.collection === "available-section" &&
                        selection.resolveType === section.resolveType;
                      const typeLabel = section.resolveType
                        .split("/")
                        .pop()
                        ?.replace(/\.tsx?$/, "");
                      return (
                        <ItemRow
                          key={section.resolveType}
                          icon={LayoutAlt01}
                          title={section.title}
                          subtitle={typeLabel ?? section.resolveType}
                          active={isActive}
                          onClick={() =>
                            onSelect({
                              collection: "available-section",
                              resolveType: section.resolveType,
                              title: section.title,
                            })
                          }
                        />
                      );
                    })}
                  </>
                )}
              </>
            )
          ) : activeCollection === "apps" ? (
            appCatalogLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loading01
                  size={18}
                  className="animate-spin text-muted-foreground"
                />
              </div>
            ) : filteredApps.length === 0 ? (
              <ListEmpty
                hasItems={appCatalog.length > 0}
                emptyLabel="No apps found."
                emptyHint="Try a different search term."
              />
            ) : (
              filteredApps.map((entry) => {
                const isActive =
                  selection?.collection === "apps" &&
                  entry.blockKey !== null &&
                  selection.key === entry.blockKey;
                return (
                  <ItemRow
                    key={entry.id}
                    icon={Grid01}
                    logoUrl={entry.logo}
                    title={entry.title}
                    subtitle={entry.category}
                    active={isActive}
                    trailing={
                      entry.installed ? (
                        <span className="shrink-0 rounded-full bg-success/15 px-1.5 py-0.5 text-[10px] font-medium text-success">
                          Installed
                        </span>
                      ) : undefined
                    }
                    onClick={() => {
                      if (!entry.installed || !entry.blockKey) {
                        toast.message(
                          `${entry.title} is not installed on this site.`,
                        );
                        return;
                      }
                      onSelect({ collection: "apps", key: entry.blockKey });
                    }}
                  />
                );
              })
            )
          ) : activeCollection === "redirects" ? (
            filteredRedirects.length === 0 ? (
              <ListEmpty
                hasItems={redirects.length > 0}
                emptyLabel="No redirects yet."
                emptyHint='Click "+" to create your first redirect.'
              />
            ) : (
              filteredRedirects.map((entry) => (
                <ItemRow
                  key={entry.key}
                  icon={CornerUpRight}
                  title={entry.from || "(no source)"}
                  subtitle={`→ ${entry.to || "(no target)"}`}
                  active={
                    selection?.collection === "redirects" &&
                    selection.key === entry.key
                  }
                  trailing={<RedirectTypeBadge type={entry.type} />}
                  onClick={() =>
                    onSelect({ collection: "redirects", key: entry.key })
                  }
                  menu={
                    <ItemActions onDelete={() => onDeleteRedirect(entry)} />
                  }
                />
              ))
            )
          ) : isPostsCollection ? (
            sortedPosts.length === 0 ? (
              <ListEmpty
                hasItems={postsWithMeta.length > 0}
                emptyLabel="No posts yet."
                emptyHint='Click "+" to create your first post.'
              />
            ) : (
              sortedPosts.map((post) => {
                const entry: BlogEntry = {
                  key: post.key,
                  kind: "posts",
                  label: post.title,
                  subtitle: post.slug,
                };
                return (
                  <ItemRow
                    key={post.key}
                    icon={File02}
                    title={post.title}
                    subtitle={post.slug || "no slug"}
                    invalid={post.missing.length > 0}
                    invalidReason={`Missing: ${post.missing.join(", ")}`}
                    active={
                      selection?.collection === "posts" &&
                      selection.key === post.key
                    }
                    selectable
                    selectionActive={selectionActive}
                    selected={selectedPostKeys.has(post.key)}
                    onToggleSelect={() => onTogglePostSelect(post.key)}
                    onClick={() =>
                      selectionActive
                        ? onTogglePostSelect(post.key)
                        : onSelect({ collection: "posts", key: post.key })
                    }
                    menu={
                      <ItemActions
                        onDuplicate={() => onDuplicateBlog(entry)}
                        onDelete={() => onDeleteBlog(entry)}
                      />
                    }
                  />
                );
              })
            )
          ) : filteredBlog.length === 0 ? (
            <ListEmpty
              hasItems={blogEntries.length > 0}
              emptyLabel={`No ${activeCollection} yet.`}
              emptyHint={`Click "+" to create your first ${
                isBlogKind(activeCollection)
                  ? BLOG_SINGULAR[activeCollection]
                  : "item"
              }.`}
            />
          ) : (
            filteredBlog.map((entry) => {
              const isActive =
                selection?.collection === entry.kind &&
                selection.key === entry.key;
              return (
                <ItemRow
                  key={entry.key}
                  icon={
                    entry.kind === "posts"
                      ? File02
                      : entry.kind === "authors"
                        ? Users01
                        : Tag01
                  }
                  title={entry.label}
                  subtitle={entry.subtitle}
                  active={isActive}
                  onClick={() =>
                    onSelect({ collection: entry.kind, key: entry.key })
                  }
                  menu={
                    <ItemActions
                      onDuplicate={() => onDuplicateBlog(entry)}
                      onDelete={() => onDeleteBlog(entry)}
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
