import { useOptionalChatTask } from "@/components/chat/chat-context";
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
} from "@decocms/ui/components/alert-dialog.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { ScrollArea } from "@decocms/ui/components/scroll-area.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useT } from "@/i18n/use-t.ts";
import { useProjectContext } from "@/sdk";
import { useInsetContext } from "@/layouts/agent-shell-layout";
import { useChatTask } from "@/components/chat/context";
import { useDecofile } from "@/components/sections-editor/use-decofile";
import { useLiveMeta } from "@/components/sections-editor/use-live-meta";
import { hasEditableAppEditorSchema } from "./app-editor-schema";
import { type LiveMeta } from "@/components/sections-editor/resolve-schema";
import { useSaveBlock } from "@/components/sections-editor/use-save-block";
import { useDeleteBlock } from "@/components/sections-editor/use-delete-block";
import {
  extractGlobalSections,
  extractPages,
  findSiteAppEntry,
  hasEditableDecoContent,
  resolveDeepLinkPage,
  type GlobalSectionEntry,
  type PageDeepLink,
  type PageEntry,
} from "@/components/sections-editor/page-list";
import type { AppCatalogEntry } from "./app-catalog";
import { ListEmpty } from "./list-empty";
import { useDecoAppsCatalog } from "@/hooks/use-deco-apps-catalog";
import { normalizePagePath } from "@/components/sections-editor/page-path-utils";
import {
  appendPageVariantSections,
  getPageVariantCount,
  getPageVariantSectionsAt,
} from "@/components/sections-editor/page-variants";
import { listAvailableSections } from "@/components/sections-editor/section-catalog";
import { createReferencedBlockSaver } from "@/components/sections-editor/save-referenced-block";
import { CollectionsSidebar } from "./collections-sidebar";
import { useSandboxEvents } from "@/components/sandbox/hooks/use-sandbox-events";
import { useSandboxLifecycle } from "@/components/sandbox/hooks/sandbox-lifecycle-context";
import { SandboxStateRenderer } from "./sandbox-state-renderer";
import { resolveContentSandboxGate } from "./content-sandbox-gate";
import { useSessionRuntime } from "@/hooks/use-session-runtime";
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
  BLOG_KINDS,
  BLOG_SINGULAR,
  buildBlogBlock,
  emptyBlogPayload,
  generateBlogKey,
  getBlogPayload,
  isBlogKind,
  listBlogPayloads,
  postIdOfKey,
  removeCategoryFromPost,
  scanBlogEntries,
  stampPostModified,
} from "./blog/blog-data";
import {
  rescheduleToDay,
  scheduledPostPayload,
} from "./blog/post-calendar-data";
import { useBlogSupport } from "./blog/use-blog-support";
import { usePostStatusMove } from "./blog/use-post-status-move";
import {
  PostsWorkspace,
  type PostsGroupBy,
  type PostsView,
} from "./blog/posts-workspace";
import { PageJsonDialog } from "@/components/sections-editor/page-json-dialog";
import { RunnableBlocksBrowser } from "./runnable-blocks-browser";
import { countAvailableRunnables } from "./runnable-catalog";
import { EmptyMessage } from "./empty-message";
import { SectionsRightPane } from "./sections-right-pane";
import { ItemActions } from "./item-actions";
import { ItemRow } from "./item-row";
import {
  GroupHeader,
  groupSavedSectionsByResolveType,
} from "./section-group-header";

const AppEditor = lazy(() =>
  import("./app-editor").then((m) => ({ default: m.AppEditor })),
);

const PostEditor = lazy(() =>
  import("./blog/post-editor").then((m) => ({ default: m.PostEditor })),
);

const RecordEditor = lazy(() =>
  import("./blog/record-editor").then((m) => ({ default: m.RecordEditor })),
);

const BlogContext = lazy(() =>
  import("./blog/context").then((m) => ({
    default: m.BlogContext,
  })),
);

const CategoryEditor = lazy(() =>
  import("./blog/category-editor").then((m) => ({ default: m.CategoryEditor })),
);

const SectionsEditor = lazy(() =>
  import("@/components/sections-editor/sections-editor").then((m) => ({
    default: m.SectionsEditor,
  })),
);

const SeoEditor = lazy(() =>
  import("@/components/sections-editor/seo-editor").then((m) => ({
    default: m.SeoEditor,
  })),
);

const VariantCalendar = lazy(() =>
  import("./variant-calendar/variant-calendar").then((m) => ({
    default: m.VariantCalendar,
  })),
);

const PostCalendar = lazy(() =>
  import("./blog/post-calendar").then((m) => ({ default: m.PostCalendar })),
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
  | "post-schedule"
  | "loaders"
  | "actions"
  | "redirects"
  | "context"
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
  | null;

export interface ContentBrowserProps {
  /** Storefront "." deep-link: preselect this page once the decofile loads. */
  deepLinkPage?: PageDeepLink;
}

export function ContentBrowser({ deepLinkPage }: ContentBrowserProps) {
  const inset = useInsetContext();
  const { currentBranch: branch } = useChatTask();
  const { org } = useProjectContext();

  const virtualMcpId = inset?.entity?.id ?? null;

  const vmEvents = useSandboxEvents();
  // Resolve the sandbox from the shared lifecycle context — the same source
  // Preview reads. A thread-scoped repo bound by `load_repo` lives on the
  // thread (not the agent entity), and the lifecycle provider already merges
  // that in. Reading `inset.entity.metadata.sandboxMap` directly would miss it
  // and strand Content on "starting" for the ephemeral Decopilot agent.
  const lifecycle = useSandboxLifecycle();
  const { runtime, previewServerUrl } = useSessionRuntime(virtualMcpId);
  const fastPreviewActive = runtime === "cms";
  const gate = resolveContentSandboxGate({
    fastPreviewActive,
    previewState: lifecycle.previewState,
    lifecyclePhase: vmEvents.lifecycle.phase,
  });

  if (gate.kind === "sandbox-card") {
    return (
      <SandboxStateRenderer
        state={gate.state}
        claimPhase={vmEvents.phase}
        lifecycle={vmEvents.lifecycle}
        onStart={lifecycle.start}
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
      previewUrl={lifecycle.previewUrl}
      sitePreviewUrl={
        fastPreviewActive ? previewServerUrl : lifecycle.previewUrl
      }
      deepLinkPage={deepLinkPage}
      devServerReady={gate.devServerReady}
      sandboxWarming={gate.sandboxWarming}
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
  sitePreviewUrl,
  deepLinkPage,
  devServerReady,
  sandboxWarming,
}: {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
  /**
   * Sandbox dev-server origin — `null` without a pod, so anything that
   * executes against it (loaders, actions, `@options` fields) stays disabled
   * in a sandbox-less session, exactly as before.
   */
  previewUrl: string | null;
  /**
   * Origin for LINKS to the site's own pages, which a sandbox-less session
   * points at its preview server. Read-only navigation targets the browser
   * follows — never a fetch the server makes on the user's behalf.
   */
  sitePreviewUrl: string | null;
  /** Storefront "." deep-link: preselect this page once the decofile loads. */
  deepLinkPage?: PageDeepLink;
  devServerReady: boolean;
  sandboxWarming: boolean;
}) {
  const t = useT();
  const threadId = useOptionalChatTask()?.taskId ?? null;
  const fetchParams = { orgSlug, virtualMcpId, branch, threadId, previewUrl };
  const { data: decofile, isLoading: decofileLoading } = useDecofile(
    fetchParams,
    { fetchEnabled: devServerReady },
  );

  const [activeCollection, setActiveCollection] =
    useState<CollectionId>("pages");
  const [selection, setSelection] = useState<Selection>(null);
  // Page that should open with the inline SEO form in SectionsEditor.
  const [openPageSeoKey, setOpenPageSeoKey] = useState<string | null>(null);
  // Storefront "." deep-link: open the visited page once the decofile loads. One-shot, so a later manual selection is never clobbered.
  const hasDeepLink = !!(
    deepLinkPage?.pageId ||
    deepLinkPage?.path ||
    deepLinkPage?.pathTemplate
  );
  const [seededDeepLink, setSeededDeepLink] = useState(false);
  if (hasDeepLink && !seededDeepLink && selection === null && decofile) {
    setSeededDeepLink(true);
    const match = resolveDeepLinkPage(
      extractPages(decofile),
      deepLinkPage ?? {},
    );
    if (match) {
      setActiveCollection("pages");
      setSelection({ collection: "pages", key: match.key, path: match.path });
    }
  }
  const [searchQuery, setSearchQuery] = useState("");
  // Posts workspace view + grouping — lifted so they survive opening a post.
  const [postsView, setPostsView] = useState<PostsView>("board");
  const [postsGroupBy, setPostsGroupBy] = useState<PostsGroupBy>("status");
  const selectItem = (next: Selection) => {
    setSelection(next);
    setOpenPageSeoKey(null);
  };
  // Reset search when switching collections (derived-state sync pattern).
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

  const blogSupport = useBlogSupport({
    orgSlug,
    virtualMcpId,
    branch,
    meta,
  });

  const saveBlock = useSaveBlock(fetchParams);
  const deleteBlock = useDeleteBlock(fetchParams);

  const postMove = usePostStatusMove({
    orgSlug,
    virtualMcpId,
    branch,
    decofile: decofile ?? {},
    support: blogSupport,
    onMoved: (fromKey: string, toKey: string) =>
      setSelection((current) =>
        current?.collection === "posts" && current.key === fromKey
          ? { collection: "posts", key: toKey }
          : current,
      ),
  });

  // Dialog state
  const [pageDialog, setPageDialog] = useState<PageDialogState>(null);
  const [pageDialogError, setPageDialogError] = useState<string | undefined>();
  const [renameSectionKey, setRenameSectionKey] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget>(null);
  const [jsonPageKey, setJsonPageKey] = useState<string | null>(null);

  // Prefer any data we already have: the committed `.deco/*.gen.json` snapshot
  // keeps the CMS editable even while the dev server is down (see useDecofile),
  // so only spin while the data is genuinely absent AND the sandbox is still
  // warming up (repo cloning / installing / starting). Once it reaches a
  // terminal phase — or the dev server is up but the fetch failed — fall
  // through to the error below instead of spinning forever.
  const dataMissing = !decofile || !meta;
  if (decofileLoading || metaLoading || (dataMissing && sandboxWarming)) {
    return (
      <div className="h-full w-full flex items-center justify-center">
        <Loading01 size={20} className="animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (dataMissing) {
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
    toast.success(
      t("sandbox.contentBrowser.createdSection", { name: blockId }),
    );
    setSelection({ collection: "sections", key: blockId });
  };

  // Persist nested saved-block references created from within the section form.
  const saveReferencedBlock = createReferencedBlockSaver((blockKey, data) =>
    saveBlock.mutate({ blockKey, data }),
  );

  const handleDuplicateSection = async (section: GlobalSectionEntry) => {
    const source = decofile[section.key] as Record<string, unknown> | undefined;
    if (!source) {
      toast.error(t("sandbox.contentBrowser.sectionNotFound"));
      return;
    }
    const newKey = nextUniqueBlockKey(decofile, section.key);
    const newName = nextUniqueName(takenSectionNames, section.name);
    const data: Record<string, unknown> = { ...source, name: newName };
    try {
      await saveBlock.mutateAsync({ blockKey: newKey, data });
      toast.success(
        t("sandbox.contentBrowser.duplicatedSection", { name: section.name }),
      );
      setSelection({ collection: "sections", key: newKey });
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : t("sandbox.contentBrowser.duplicateFailed"),
      );
    }
  };

  const handleRenameSection = async (newName: string) => {
    if (!renameSectionKey) return;
    const source = decofile[renameSectionKey] as
      | Record<string, unknown>
      | undefined;
    if (!source) {
      toast.error(t("sandbox.contentBrowser.sectionNotFound"));
      return;
    }
    try {
      await saveBlock.mutateAsync({
        blockKey: renameSectionKey,
        data: { ...source, name: newName },
      });
      toast.success(t("sandbox.contentBrowser.sectionRenamed"));
      setRenameSectionKey(null);
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : t("sandbox.contentBrowser.renameFailed"),
      );
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
      await saveBlock.mutateAsync({ blockKey: key, data });
      toast.success(`Created ${BLOG_SINGULAR[kind]}`);
      setSelection({ collection: kind, key });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not create");
    }
  };

  /** Calendar "+" on a day: a post scheduled for that day, opened to edit. */
  const handleCreateScheduledPost = async (day: Date) => {
    const key = generateBlogKey(decofile, "posts");
    const data = buildBlogBlock(key, "posts", scheduledPostPayload(day));
    try {
      await saveBlock.mutateAsync({ blockKey: key, data });
      toast.success(t("sandbox.postCalendar.createdScheduledPost"));
      setActiveCollection("posts");
      setPrevCollection("posts");
      setSelection({ collection: "posts", key });
      setOpenPageSeoKey(null);
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : t("sandbox.postCalendar.couldNotCreate"),
      );
    }
  };

  /** Calendar drag: move an already-scheduled post to another day. */
  const handleReschedulePost = async (key: string, day: Date) => {
    const source = decofile[key] as Record<string, unknown> | undefined;
    const payload = source
      ? rescheduleToDay(getBlogPayload(source, "posts"), day)
      : null;
    if (!payload) {
      toast.error(t("sandbox.postCalendar.onlyScheduledCanMove"));
      return;
    }
    try {
      await saveBlock.mutateAsync({
        blockKey: key,
        data: buildBlogBlock(key, "posts", payload),
      });
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : t("sandbox.postCalendar.couldNotReschedule"),
      );
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
      await saveBlock.mutateAsync({
        blockKey: key,
        data: buildBlogBlock(key, entry.kind, payload),
      });
      toast.success(`Duplicated "${entry.label}"`);
      setSelection({ collection: entry.kind, key });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Duplicate failed");
    }
  };

  /** Jump to the posts workspace from a category's "Manage posts" action. */
  const handleManagePosts = () => {
    setActiveCollection("posts");
    setPrevCollection("posts");
    setSelection(null);
    setOpenPageSeoKey(null);
    setSearchQuery("");
  };

  // ------------------ Delete ------------------
  const confirmDelete = async () => {
    if (!deleteTarget) return;
    try {
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
              await saveBlock.mutateAsync({
                blockKey: postKey,
                data: buildBlogBlock(postKey, "posts", stampPostModified(next)),
              });
            }
          }
        }
        await deleteBlock.mutateAsync({ blockKey: key });
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
  // `saveBlock` too: a category delete rewrites its posts before unlinking it.
  const isDeleting = deleteBlock.isPending || saveBlock.isPending;
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
      {activeCollection !== "seo" &&
        activeCollection !== "site" &&
        activeCollection !== "context" &&
        activeCollection !== "calendar" &&
        activeCollection !== "post-schedule" &&
        activeCollection !== "posts" &&
        activeCollection !== "loaders" &&
        activeCollection !== "actions" && (
          <ItemList
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
            selection={selection}
            onSelect={selectItem}
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
            ) : activeCollection === "post-schedule" ? (
              <PostCalendar
                decofile={decofile}
                support={blogSupport}
                isCreating={saveBlock.isPending}
                onCreate={(day) => void handleCreateScheduledPost(day)}
                onReschedule={(key, day) => void handleReschedulePost(key, day)}
                onSelect={(key) => {
                  setActiveCollection("posts");
                  setPrevCollection("posts");
                  setSelection({ collection: "posts", key });
                  setOpenPageSeoKey(null);
                }}
              />
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
            ) : activeCollection === "context" ? (
              <BlogContext
                orgSlug={orgSlug}
                virtualMcpId={virtualMcpId}
                branch={branch}
                decofile={decofile}
                meta={meta}
                onOpenPost={(key) => {
                  setActiveCollection("posts");
                  setPrevCollection("posts");
                  setSelection({ collection: "posts", key });
                  setOpenPageSeoKey(null);
                }}
                onManageCategoryPosts={() => {
                  setActiveCollection("posts");
                  setPrevCollection("posts");
                  setSelection(null);
                  setOpenPageSeoKey(null);
                }}
              />
            ) : activeCollection === "seo" ? (
              <SeoEditor
                orgSlug={orgSlug}
                virtualMcpId={virtualMcpId}
                branch={branch}
                decofile={decofile}
                meta={meta}
                target={{ kind: "site" }}
                previewBaseUrl={sitePreviewUrl}
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
            ) : activeCollection === "posts" ? (
              <PostsWorkspace
                orgSlug={orgSlug}
                virtualMcpId={virtualMcpId}
                branch={branch}
                decofile={decofile}
                view={postsView}
                groupBy={postsGroupBy}
                selectedKey={
                  selection?.collection === "posts" ? selection.key : null
                }
                onViewChange={(next) => {
                  setPostsView(next);
                  setSelection(null);
                }}
                onGroupByChange={setPostsGroupBy}
                onClose={() => setSelection(null)}
                onOpen={(key) => {
                  setSelection({ collection: "posts", key });
                  setOpenPageSeoKey(null);
                }}
                move={postMove}
                support={blogSupport}
                meta={meta}
                renderDetail={(key, controls) => (
                  <PostEditor
                    key={`post:${postIdOfKey(key)}`}
                    orgSlug={orgSlug}
                    virtualMcpId={virtualMcpId}
                    branch={branch}
                    blockKey={key}
                    block={decofile[key] as Record<string, unknown>}
                    decofile={decofile}
                    meta={meta}
                    previewBaseUrl={sitePreviewUrl}
                    move={postMove}
                    onClose={controls?.onClose}
                    expanded={controls?.expanded}
                    onToggleExpand={controls?.onToggleExpand}
                  />
                )}
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
                  onManagePosts={() => handleManagePosts()}
                  onOpenPost={(key) => {
                    setActiveCollection("posts");
                    setPrevCollection("posts");
                    setSelection({ collection: "posts", key });
                    setOpenPageSeoKey(null);
                  }}
                  previewBaseUrl={sitePreviewUrl}
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
  onDeleteRedirect,
  onDuplicateBlog,
  onDeleteBlog,
}: {
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
    <div className="shrink-0 border-r flex flex-col min-h-0 w-[300px]">
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
