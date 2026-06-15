import { type Query, Suspense, lazy, useState } from "react";
import {
  AlertCircle,
  BookOpen01,
  Code01,
  Copy01,
  DotsHorizontal,
  Edit01,
  File02,
  Flag01,
  Globe02,
  Grid01,
  LayoutAlt01,
  Loading01,
  Plus,
  SearchLg,
  Settings01,
  Tag01,
  CreditCardSearch,
  Trash01,
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
import { useDecoAppsCatalog } from "@/web/hooks/use-deco-apps-catalog";
import { normalizePagePath } from "@/web/components/sections-editor/page-path-utils";
import {
  appendPageVariantSections,
  getPageVariantCount,
  getPageVariantSectionsAt,
} from "@/web/components/sections-editor/page-variants";
import type { SectionCatalogEntry } from "@/web/components/sections-editor/section-catalog";
import { useSandboxEvents } from "@/web/components/sandbox/hooks/use-sandbox-events";
import {
  sandboxUserStop,
  useSandboxStart,
  type SandboxStartArgs,
} from "@/web/components/sandbox/hooks/use-sandbox-start";
import { SandboxStateCard } from "@/web/components/sandbox/preview/state-card";
import { derivePhaseProgress } from "@/web/components/sandbox/preview/derive-phase-progress";
import { computePreviewState } from "@/web/components/sandbox/preview/preview-state";
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
  type BlogEntry,
  type BlogKind,
  BLOG_KINDS,
  BLOG_SINGULAR,
  buildBlogBlock,
  emptyBlogPayload,
  generateBlogKey,
  getBlogPayload,
  isBlogKind,
  scanBlogEntries,
} from "./blog/blog-data";
import {
  useDeleteBlogBlock,
  useSaveBlogBlock,
} from "./blog/use-blog-mutations";
import { PageJsonDialog } from "@/web/components/sections-editor/page-json-dialog";

const AppEditor = lazy(() =>
  import("./app-editor").then((m) => ({ default: m.AppEditor })),
);

const PostEditor = lazy(() =>
  import("./blog/post-editor").then((m) => ({ default: m.PostEditor })),
);

const RecordEditor = lazy(() =>
  import("./blog/record-editor").then((m) => ({ default: m.RecordEditor })),
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

const AddSectionModal = lazy(() =>
  import("@/web/components/sections-editor/add-section-modal").then((m) => ({
    default: m.AddSectionModal,
  })),
);

const VARIANT_GREEN = "oklch(0.65 0.15 160)";

type CollectionId = "pages" | "sections" | "apps" | "site" | "seo" | BlogKind;

type Selection =
  | { collection: "pages"; key: string; path: string }
  | { collection: "sections"; key: string }
  | { collection: "apps"; key: string }
  | { collection: BlogKind; key: string }
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
  | { kind: "blog"; blogKind: BlogKind; key: string; label: string }
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
  });

  if (sandboxState.kind !== "iframe") {
    return (
      <SandboxStateRenderer
        state={sandboxState}
        claimPhase={vmEvents.phase}
        lifecycle={vmEvents.lifecycle}
        onStart={triggerStart}
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
}: {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
  previewUrl: string | null;
}) {
  const fetchParams = { orgSlug, virtualMcpId, branch };
  const { data: decofile, isLoading: decofileLoading } =
    useDecofile(fetchParams);

  const [activeCollection, setActiveCollection] =
    useState<CollectionId>("pages");
  const [selection, setSelection] = useState<Selection>(null);
  // Page that should open with the inline SEO form in SectionsEditor.
  const [openPageSeoKey, setOpenPageSeoKey] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  // Reset search when switching collections (derived-state sync pattern)
  const [prevCollection, setPrevCollection] = useState(activeCollection);
  if (prevCollection !== activeCollection) {
    setPrevCollection(activeCollection);
    setSearchQuery("");
  }

  const {
    data: meta,
    isLoading: metaLoading,
    isFetching: metaFetching,
  } = useLiveMeta(fetchParams, {
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
  const saveBlogBlock = useSaveBlogBlock(fetchParams);
  const deleteBlogBlock = useDeleteBlogBlock(fetchParams);

  // Dialog state
  const [pageDialog, setPageDialog] = useState<PageDialogState>(null);
  const [pageDialogError, setPageDialogError] = useState<string | undefined>();
  const [addSectionOpen, setAddSectionOpen] = useState(false);
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
  const globalSections = extractGlobalSections(decofile, meta);
  const siteApp = findSiteAppEntry(decofile, meta);
  const allBlogEntries = scanBlogEntries(decofile);
  const showBlog = BLOG_KINDS.some((k) => allBlogEntries[k].length > 0);
  const blogEntries = isBlogKind(activeCollection)
    ? allBlogEntries[activeCollection]
    : [];

  if (!hasEditableDecoContent(decofile, meta) && !showBlog) {
    return (
      <EmptyMessage
        icon={AlertCircle}
        title="No editable content"
        description="This project doesn't expose any Deco pages, sections, or apps."
      />
    );
  }

  const counts: Record<
    "pages" | "sections" | "apps" | "posts" | "authors" | "categories",
    number
  > = {
    pages: pages.length,
    sections: globalSections.length,
    apps: appCatalog.length,
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

  // ------------------ Delete ------------------
  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const { kind, key, label } = deleteTarget;
    try {
      if (kind === "blog") {
        await deleteBlogBlock.mutateAsync({ blockKey: key });
      } else {
        await deleteBlock.mutateAsync({ blockKey: key });
      }
      toast.success(`Deleted "${label}"`);
      if (selection && selection.key === key) {
        setSelection(null);
      }
      setDeleteTarget(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Delete failed");
    }
  };

  // ------------------ Render ------------------
  const isDeleting = deleteBlock.isPending || deleteBlogBlock.isPending;
  const deleteNoun =
    deleteTarget?.kind === "blog"
      ? BLOG_SINGULAR[deleteTarget.blogKind]
      : (deleteTarget?.kind ?? "item");
  return (
    <div className="flex h-full w-full">
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
      {activeCollection !== "seo" && activeCollection !== "site" && (
        <ItemList
          activeCollection={activeCollection}
          pages={pages}
          sections={globalSections}
          appCatalog={appCatalog}
          appCatalogLoading={appCatalogLoading}
          blogEntries={blogEntries}
          decofile={decofile}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          selection={selection}
          onSelect={(next) => {
            setSelection(next);
            setOpenPageSeoKey(null);
          }}
          previewUrl={previewUrl}
          onCreate={() => {
            if (activeCollection === "pages") {
              openCreatePage();
            } else if (isBlogKind(activeCollection)) {
              void handleCreateBlog(activeCollection);
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
          onEditPageSeo={(page) => {
            setSelection({
              collection: "pages",
              key: page.key,
              path: page.path,
            });
            setOpenPageSeoKey(page.key);
          }}
          onViewPageJson={(page) => setJsonPageKey(page.key)}
          onDuplicateSection={handleDuplicateSection}
          onRenameSection={(s) => setRenameSectionKey(s.key)}
          onDeleteSection={(s) =>
            setDeleteTarget({ kind: "section", key: s.key, label: s.name })
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
          {activeCollection === "site" ? (
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
                schemaPending={isAppSchemaLoading(siteApp.resolveType, ["seo"])}
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
          ) : selection ? (
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
              />
            ) : selection.collection === "authors" ||
              selection.collection === "categories" ? (
              <RecordEditor
                key={`${selection.collection}:${selection.key}`}
                orgSlug={orgSlug}
                virtualMcpId={virtualMcpId}
                branch={branch}
                kind={selection.collection}
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
                onExitSeo={() => setOpenPageSeoKey(null)}
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

      {/* Page JSON dialog */}
      {jsonPageKey && (
        <PageJsonDialog
          open={!!jsonPageKey}
          onOpenChange={(open) => {
            if (!open) setJsonPageKey(null);
          }}
          pageKey={jsonPageKey}
          decofile={decofile}
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

function CollectionsSidebar({
  active,
  counts,
  showBlog,
  onSelect,
}: {
  active: CollectionId;
  counts: Record<
    "pages" | "sections" | "apps" | "posts" | "authors" | "categories",
    number
  >;
  showBlog: boolean;
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
        <CollectionRow
          id="apps"
          icon={Grid01}
          label="Apps"
          count={counts.apps}
          active={active === "apps"}
          onSelect={onSelect}
        />
        {showBlog && (
          <>
            <div className="mt-3 flex items-center gap-1.5 px-2.5 pb-1 pt-1 text-xs font-medium text-muted-foreground/70">
              <BookOpen01 size={13} className="shrink-0" />
              Blog
            </div>
            <CollectionRow
              id="posts"
              icon={File02}
              label="Posts"
              count={counts.posts}
              active={active === "posts"}
              onSelect={onSelect}
            />
            <CollectionRow
              id="authors"
              icon={Users01}
              label="Authors"
              count={counts.authors}
              active={active === "authors"}
              onSelect={onSelect}
            />
            <CollectionRow
              id="categories"
              icon={Tag01}
              label="Categories"
              count={counts.categories}
              active={active === "categories"}
              onSelect={onSelect}
            />
          </>
        )}
        <CollectionRow
          id="site"
          icon={Settings01}
          label="Site"
          active={active === "site"}
          onSelect={onSelect}
        />
        <CollectionRow
          id="seo"
          icon={CreditCardSearch}
          label="SEO"
          active={active === "seo"}
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
  count?: number;
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
      {count !== undefined && (
        <span
          className={cn(
            "shrink-0 text-xs tabular-nums",
            active ? "text-accent-foreground/70" : "text-muted-foreground/70",
          )}
        >
          {count}
        </span>
      )}
    </button>
  );
}

function ItemList({
  activeCollection,
  pages,
  sections,
  appCatalog,
  appCatalogLoading,
  blogEntries,
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
  onEditPageSeo,
  onViewPageJson,
  onDuplicateSection,
  onRenameSection,
  onDeleteSection,
  onDuplicateBlog,
  onDeleteBlog,
}: {
  activeCollection: CollectionId;
  pages: PageEntry[];
  sections: GlobalSectionEntry[];
  appCatalog: AppCatalogEntry[];
  appCatalogLoading: boolean;
  blogEntries: BlogEntry[];
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
  onEditPageSeo: (page: PageEntry) => void;
  onViewPageJson: (page: PageEntry) => void;
  onDuplicateSection: (section: GlobalSectionEntry) => void;
  onRenameSection: (section: GlobalSectionEntry) => void;
  onDeleteSection: (section: GlobalSectionEntry) => void;
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
  const filteredSections = sections.filter(
    (s) =>
      !q ||
      s.name.toLowerCase().includes(q) ||
      s.key.toLowerCase().includes(q) ||
      s.resolveType.toLowerCase().includes(q),
  );
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

  const placeholder = `Search ${activeCollection}…`;
  const createTooltip = isBlogKind(activeCollection)
    ? `Create new ${BLOG_SINGULAR[activeCollection]}`
    : activeCollection === "pages"
      ? "Create new page"
      : "Create new section";
  const sectionCreateBlocked = activeCollection === "sections" && !previewUrl;
  const showCreateButton = activeCollection !== "apps";
  const createDisabled = sectionCreateBlocked;
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
        {showCreateButton && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={onCreate}
                disabled={createDisabled}
                aria-label={createTooltip}
                aria-disabled={createDisabled}
              >
                <Plus size={14} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {createDisabledReason ?? createTooltip}
            </TooltipContent>
          </Tooltip>
        )}
      </div>
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
            filteredSections.length === 0 ? (
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
                        <span className="shrink-0 rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-400">
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

function ItemRow({
  icon: Icon,
  logoUrl,
  title,
  subtitle,
  active,
  variantCount,
  trailing,
  onClick,
  menu,
}: {
  icon: React.ComponentType<{
    size?: number;
    className?: string;
    style?: React.CSSProperties;
  }>;
  logoUrl?: string;
  title: string;
  subtitle: string;
  active: boolean;
  variantCount?: number;
  trailing?: React.ReactNode;
  onClick: () => void;
  menu?: React.ReactNode;
}) {
  const rowIcon =
    variantCount && variantCount > 1 ? (
      <Tooltip>
        <TooltipTrigger asChild>
          <Icon
            size={16}
            className="shrink-0"
            style={{ color: VARIANT_GREEN }}
          />
        </TooltipTrigger>
        <TooltipContent side="right">{variantCount} variants</TooltipContent>
      </Tooltip>
    ) : logoUrl ? (
      <img
        src={logoUrl}
        alt=""
        className="size-8 shrink-0 rounded-lg object-cover bg-muted"
      />
    ) : (
      <Icon
        size={16}
        className={cn(
          "shrink-0",
          active ? "text-accent-foreground" : "text-muted-foreground",
        )}
      />
    );

  return (
    <div
      className={cn(
        "group relative flex min-w-0 items-center rounded-md transition-colors",
        active ? "bg-accent text-accent-foreground" : "hover:bg-muted",
      )}
    >
      <button
        type="button"
        onClick={onClick}
        className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-2.5 py-2 text-left cursor-pointer"
      >
        {rowIcon}
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
        {trailing}
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
  onEditSeo,
  onViewJson,
  onDelete,
}: {
  onDuplicate: () => void;
  onRename?: () => void;
  onAddVariant?: () => void;
  onEditSeo?: () => void;
  onViewJson?: () => void;
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
        {onRename && (
          <DropdownMenuItem onClick={onRename}>
            <Edit01 size={14} />
            Rename
          </DropdownMenuItem>
        )}
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
        {(onEditSeo || onViewJson) && (
          <>
            <DropdownMenuSeparator />
            {onEditSeo && (
              <DropdownMenuItem onClick={onEditSeo}>
                <CreditCardSearch size={14} />
                Edit SEO
              </DropdownMenuItem>
            )}
            {onViewJson && (
              <DropdownMenuItem onClick={onViewJson}>
                <Code01 size={14} />
                View JSON
              </DropdownMenuItem>
            )}
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
 * "Starting your sandbox" / "Sandbox is paused" cards. The daemon's
 * HTTP proxy serves every other "not live" case as auto-reloading
 * HTML through the iframe, so Content only needs these two overlays.
 */
function SandboxStateRenderer({
  state,
  claimPhase,
  lifecycle,
  onStart,
}: {
  state: { kind: "starting" } | { kind: "suspended" };
  claimPhase: ReturnType<typeof useSandboxEvents>["phase"];
  lifecycle: ReturnType<typeof useSandboxEvents>["lifecycle"];
  onStart: () => void;
}) {
  switch (state.kind) {
    case "starting":
      return (
        <SandboxStateCard
          kind="starting"
          progress={derivePhaseProgress({ claimPhase, lifecycle })}
          claimPhase={claimPhase}
        />
      );
    case "suspended":
      return <SandboxStateCard kind="suspended" onResume={onStart} />;
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
