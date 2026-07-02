import { Suspense, forwardRef, lazy, useState } from "react";
import { type Query } from "@tanstack/react-query";
import {
  AlertCircle,
  BookOpen01,
  Calendar,
  ChevronDown,
  Code01,
  Copy01,
  Database01,
  DotsHorizontal,
  Edit01,
  File02,
  FilterFunnel01,
  Flag01,
  Globe02,
  Grid01,
  LayoutAlt01,
  Loading01,
  Plus,
  SearchLg,
  Settings01,
  SwitchVertical01,
  Tag01,
  CreditCardSearch,
  Trash01,
  Users01,
  X,
  Zap,
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
import { Checkbox } from "@deco/ui/components/checkbox.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@deco/ui/components/dropdown-menu.tsx";
import { Label } from "@deco/ui/components/label.tsx";
import {
  RadioGroup,
  RadioGroupItem,
} from "@deco/ui/components/radio-group.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@deco/ui/components/select.tsx";
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
import { listAvailableSections } from "@/web/components/sections-editor/section-catalog";
import { GLOBAL_SECTION_ICON_COLOR } from "@/web/components/sections-editor/section-types";
import { suggestBlockId } from "@/web/components/sections-editor/page-sections";
import { createReferencedBlockSaver } from "@/web/components/sections-editor/save-referenced-block";
import { AvailableSectionEditor } from "./available-section-editor";
import { SavedSectionEditor } from "./saved-section-editor";
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
} from "./blog/blog-data";
import {
  useDeleteBlogBlock,
  useSaveBlogBlock,
} from "./blog/use-blog-mutations";
import { PageJsonDialog } from "@/web/components/sections-editor/page-json-dialog";
import { RunnableBlocksBrowser } from "./runnable-blocks-browser";
import { countAvailableRunnables } from "./runnable-catalog";

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

const VARIANT_GREEN = "oklch(0.65 0.15 160)";

type CollectionId =
  | "pages"
  | "sections"
  | "apps"
  | "site"
  | "seo"
  | "calendar"
  | "loaders"
  | "actions"
  | BlogKind;

type CollectionCounts = Record<
  | "pages"
  | "sections"
  | "apps"
  | "loaders"
  | "actions"
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
  | { collection: BlogKind; key: string }
  | null;

/** A raw manifest section the user can customize and save as a global block. */
export interface AvailableSectionEntry {
  resolveType: string;
  title: string;
  description?: string;
}

interface SavedSectionGroup {
  label: string;
  sections: GlobalSectionEntry[];
}

/** Short label for a section's underlying component resolveType. */
function sectionTypeLabel(resolveType: string): string {
  return (
    resolveType
      .split("/")
      .pop()
      ?.replace(/\.tsx?$/, "") ||
    resolveType ||
    "Section"
  );
}

/** Group saved sections by their underlying `resolveType`, sorted by label. */
function groupSavedSectionsByResolveType(
  sections: GlobalSectionEntry[],
): SavedSectionGroup[] {
  const byLabel = new Map<string, GlobalSectionEntry[]>();
  for (const section of sections) {
    const label = sectionTypeLabel(section.resolveType);
    const bucket = byLabel.get(label);
    if (bucket) bucket.push(section);
    else byLabel.set(label, [section]);
  }
  return [...byLabel.entries()]
    .map(([label, groupSections]) => ({ label, sections: groupSections }))
    .sort((a, b) => a.label.localeCompare(b.label));
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
  | { kind: "blog"; blogKind: BlogKind; key: string; label: string }
  | { kind: "blog-bulk"; keys: string[]; count: number }
  | null;

type PostSort = "date-desc" | "date-asc" | "az" | "za";

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
  const fetchParams = { orgSlug, virtualMcpId, branch, previewUrl };
  const { data: decofile, isLoading: decofileLoading } =
    useDecofile(fetchParams);

  const [activeCollection, setActiveCollection] =
    useState<CollectionId>("pages");
  const [selection, setSelection] = useState<Selection>(null);
  // Page that should open with the inline SEO form in SectionsEditor.
  const [openPageSeoKey, setOpenPageSeoKey] = useState<string | null>(null);
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
  // Multi-select is implicit: selecting the first post (via the hover-revealed
  // checkbox) enters "selection mode" — clearing the selection leaves it.
  const clearSelection = () => setSelectedPostKeys(new Set());
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
  const [renameSectionKey, setRenameSectionKey] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget>(null);
  const [jsonPageKey, setJsonPageKey] = useState<string | null>(null);
  // "Update category" bulk dialog — holds the count of posts it will act on.
  const [categoryDialog, setCategoryDialog] = useState<{
    count: number;
  } | null>(null);

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

  // Category choices for the bulk "Update category" dialog (parent scope, since
  // the dialog renders here rather than inside ItemList).
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

  if (!hasEditableDecoContent(decofile, meta) && !showBlog) {
    return (
      <EmptyMessage
        icon={AlertCircle}
        title="No editable content"
        description="This project doesn't expose any Deco pages, sections, or apps."
      />
    );
  }

  const counts: CollectionCounts = {
    pages: pages.length,
    sections: globalSections.length,
    apps: appCatalog.length,
    loaders: countAvailableRunnables(meta, "loaders"),
    actions: countAvailableRunnables(meta, "actions"),
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

  // Land on the posts list, optionally pre-filtered by a category (from the
  // category editor). An empty slug lands on the unfiltered list (all
  // categories) — used by the "Add posts" action for empty categories. Sync
  // `prevCollection` here so the collection-change reset above doesn't
  // immediately clear the filter we're setting.
  const handleManagePosts = (slug: string) => {
    setActiveCollection("posts");
    setPrevCollection("posts");
    setSelection(null);
    setOpenPageSeoKey(null);
    setSearchQuery("");
    setPostCategoryFilter(slug || null);
    setPostAuthorFilter(null);
    setPostSort("date-desc");
    setSelectedPostKeys(new Set());
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
        data: buildBlogBlock(key, "posts", next),
      });
      changed += 1;
    }
    return changed;
  };

  // Driven by the "Update category" dialog: applies the chosen mode, reports
  // the outcome, then closes the dialog and clears the selection.
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
      setCategoryDialog(null);
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
                data: buildBlogBlock(postKey, "posts", next),
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
        activeCollection !== "calendar" &&
        activeCollection !== "loaders" &&
        activeCollection !== "actions" && (
          <ItemList
            activeCollection={activeCollection}
            pages={pages}
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
            onTogglePostSelect={togglePostSelection}
            onSelectAllPosts={(keys) => setSelectedPostKeys(new Set(keys))}
            onClearPostSelection={() => setSelectedPostKeys(new Set())}
            onBulkUpdateCategory={() =>
              setCategoryDialog({ count: selectedPostKeys.size })
            }
            onBulkDeletePosts={() =>
              setDeleteTarget({
                kind: "blog-bulk",
                keys: [...selectedPostKeys],
                count: selectedPostKeys.size,
              })
            }
            selection={selection}
            onSelect={(next) => {
              setSelection(next);
              setOpenPageSeoKey(null);
            }}
            onCreate={() => {
              if (activeCollection === "pages") {
                openCreatePage();
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

      {/* Bulk "Update category" dialog */}
      {categoryDialog && (
        <BulkCategoryDialog
          count={categoryDialog.count}
          categories={bulkCategoryChoices}
          isPending={saveBlogBlock.isPending}
          onApply={(mode, category) =>
            void runBulkCategoryUpdate(mode, category)
          }
          onOpenChange={(open) => {
            if (!open && !saveBlogBlock.isPending) setCategoryDialog(null);
          }}
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

/**
 * Right pane for the Sections collection. A saved (global) section opens the
 * full section editor; an available (raw manifest) section opens a local
 * editor that persists only when named and saved.
 */
function SectionsRightPane({
  selection,
  orgSlug,
  virtualMcpId,
  branch,
  previewUrl,
  meta,
  decofile,
  isCreating,
  onCreateAvailable,
  onSaveReferencedBlock,
}: {
  selection:
    | { collection: "sections"; key: string }
    | {
        collection: "available-section";
        resolveType: string;
        title: string;
      }
    | null;
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
  previewUrl: string | null;
  meta: LiveMeta;
  decofile: Record<string, unknown>;
  isCreating: boolean;
  onCreateAvailable: (
    resolveType: string,
    blockId: string,
    data: Record<string, unknown>,
  ) => Promise<void>;
  onSaveReferencedBlock: (
    blockKey: string,
    data: Record<string, unknown>,
  ) => void;
}) {
  if (!selection) {
    return (
      <EmptyMessage
        title="Select a section to edit"
        description="Pick a saved section to edit it, or an available one to customize and save as global."
      />
    );
  }

  if (selection.collection === "available-section") {
    return (
      <AvailableSectionEditor
        key={`available:${selection.resolveType}`}
        orgSlug={orgSlug}
        virtualMcpId={virtualMcpId}
        branch={branch}
        previewUrl={previewUrl}
        meta={meta}
        decofile={decofile}
        resolveType={selection.resolveType}
        title={selection.title}
        defaultBlockId={suggestBlockId(selection.title)}
        isCreating={isCreating}
        onCreate={(blockId, data) =>
          onCreateAvailable(selection.resolveType, blockId, data)
        }
        onSaveReferencedBlock={onSaveReferencedBlock}
      />
    );
  }

  return (
    <SavedSectionEditor
      key={`saved:${selection.key}`}
      orgSlug={orgSlug}
      virtualMcpId={virtualMcpId}
      branch={branch}
      previewUrl={previewUrl}
      meta={meta}
      decofile={decofile}
      blockKey={selection.key}
      onSaveReferencedBlock={onSaveReferencedBlock}
    />
  );
}

export function GroupHeader({
  icon: Icon,
  label,
  className,
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  label: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-1.5 px-2.5 pb-1 pt-1 text-xs font-medium text-muted-foreground/70",
        className,
      )}
    >
      <Icon size={13} className="shrink-0" />
      {label}
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
  counts: CollectionCounts;
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
        <CollectionRow
          id="loaders"
          icon={Database01}
          label="Loaders"
          count={counts.loaders}
          active={active === "loaders"}
          onSelect={onSelect}
        />
        <CollectionRow
          id="actions"
          icon={Zap}
          label="Actions"
          count={counts.actions}
          active={active === "actions"}
          onSelect={onSelect}
        />
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
        <CollectionRow
          id="calendar"
          icon={Calendar}
          label="Calendar"
          active={active === "calendar"}
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
  onTogglePostSelect,
  onSelectAllPosts,
  onClearPostSelection,
  onBulkUpdateCategory,
  onBulkDeletePosts,
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
  onTogglePostSelect: (key: string) => void;
  onSelectAllPosts: (keys: string[]) => void;
  onClearPostSelection: () => void;
  onBulkUpdateCategory: () => void;
  onBulkDeletePosts: () => void;
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
  // filter bar and every row's checkbox becomes visible.
  const selectionActive = selectionCount > 0;
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
    : "Create new page";
  // Sections are created by saving an available section, not via the "+".
  const showCreateButton =
    activeCollection !== "apps" && activeCollection !== "sections";

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
            onUpdateCategory={onBulkUpdateCategory}
            onDelete={onBulkDeletePosts}
            onExit={onClearPostSelection}
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
                    subtitle={post.slug}
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

// Sentinel for the "no filter" radio option (Radix forbids empty values).
const ALL_FILTER = "__all__";

const POST_SORT_LABELS: Record<PostSort, string> = {
  "date-desc": "Newest first",
  "date-asc": "Oldest first",
  az: "Title A–Z",
  za: "Title Z–A",
};

const POST_SORT_SHORT: Record<PostSort, string> = {
  "date-desc": "Newest",
  "date-asc": "Oldest",
  az: "A–Z",
  za: "Z–A",
};

type CategoryOption = { slug: string; name: string; count: number };
type AuthorOption = { email: string; name: string; count: number };

/**
 * Compact, icon-led filter trigger: just the icon when no filter is applied,
 * icon + highlighted value once one is. Forwards props/ref so it can be used
 * directly as a `DropdownMenuTrigger asChild` child.
 */
const FilterChipTrigger = forwardRef<
  HTMLButtonElement,
  {
    icon: React.ComponentType<{ size?: number; className?: string }>;
    active: boolean;
    value?: string;
  } & React.ComponentProps<typeof Button>
>(function FilterChipTrigger(
  { icon: Icon, active, value, className, ...props },
  ref,
) {
  return (
    <Button
      ref={ref}
      type="button"
      variant="ghost"
      size="sm"
      className={cn(
        "h-7 gap-1 px-1.5 text-xs",
        active ? "text-foreground" : "text-muted-foreground",
        className,
      )}
      {...props}
    >
      <Icon size={14} className="shrink-0" />
      {value && <span className="min-w-0 flex-1 truncate">{value}</span>}
      <ChevronDown size={12} className="shrink-0 opacity-60" />
    </Button>
  );
});

function OptionCount({ count }: { count: number }) {
  return (
    <span className="ml-auto pl-3 text-xs text-muted-foreground tabular-nums">
      {count}
    </span>
  );
}

function PostFilterBar({
  categories,
  authors,
  categoryFilter,
  authorFilter,
  sort,
  onCategoryFilterChange,
  onAuthorFilterChange,
  onSortChange,
}: {
  categories: CategoryOption[];
  authors: AuthorOption[];
  categoryFilter: string | null;
  authorFilter: string | null;
  sort: PostSort;
  onCategoryFilterChange: (slug: string | null) => void;
  onAuthorFilterChange: (email: string | null) => void;
  onSortChange: (sort: PostSort) => void;
}) {
  const activeCategory = categories.find((c) => c.slug === categoryFilter);
  const activeAuthor = authors.find((a) => a.email === authorFilter);
  const hasFilter = !!(categoryFilter || authorFilter);
  const activeLabel = activeCategory?.name ?? activeAuthor?.name ?? "Filter";
  // One filter at a time: encode both dimensions into a single radio value.
  const activeValue = categoryFilter
    ? `cat:${categoryFilter}`
    : authorFilter
      ? `author:${authorFilter}`
      : ALL_FILTER;
  const clearFilter = () => {
    onCategoryFilterChange(null);
    onAuthorFilterChange(null);
  };
  const handleFilterChange = (v: string) => {
    if (v.startsWith("cat:")) {
      onAuthorFilterChange(null);
      onCategoryFilterChange(v.slice(4));
    } else if (v.startsWith("author:")) {
      onCategoryFilterChange(null);
      onAuthorFilterChange(v.slice(7));
    } else {
      clearFilter();
    }
  };

  return (
    <div className="flex min-w-0 items-center gap-1 overflow-hidden border-b px-2 py-1.5">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <FilterChipTrigger
            icon={FilterFunnel01}
            active={hasFilter}
            value={activeLabel}
            className="min-w-0 shrink"
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="max-h-96 w-60 overflow-y-auto"
        >
          <DropdownMenuLabel>Filter by</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={activeValue}
            onValueChange={handleFilterChange}
          >
            <DropdownMenuRadioItem value={ALL_FILTER}>
              All posts
            </DropdownMenuRadioItem>
            {categories.length > 0 && (
              <DropdownMenuLabel className="text-muted-foreground/70">
                Category
              </DropdownMenuLabel>
            )}
            {categories.map((c) => (
              <DropdownMenuRadioItem
                key={`cat:${c.slug}`}
                value={`cat:${c.slug}`}
              >
                <span className="min-w-0 flex-1 truncate">{c.name}</span>
                <OptionCount count={c.count} />
              </DropdownMenuRadioItem>
            ))}
            {authors.length > 0 && (
              <DropdownMenuLabel className="text-muted-foreground/70">
                Author
              </DropdownMenuLabel>
            )}
            {authors.map((a) => (
              <DropdownMenuRadioItem
                key={`author:${a.email}`}
                value={`author:${a.email}`}
              >
                <span className="min-w-0 flex-1 truncate">{a.name}</span>
                <OptionCount count={a.count} />
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {hasFilter && (
        <FilterClearButton label="Clear filter" onClick={clearFilter} />
      )}

      <div className="ml-auto shrink-0">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <FilterChipTrigger
              icon={SwitchVertical01}
              active
              value={POST_SORT_SHORT[sort]}
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuLabel>Sort by</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={sort}
              onValueChange={(v) => onSortChange(v as PostSort)}
            >
              {(Object.keys(POST_SORT_LABELS) as PostSort[]).map((value) => (
                <DropdownMenuRadioItem key={value} value={value}>
                  {POST_SORT_LABELS[value]}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

/** Small "×" that clears an active filter chip. */
function FilterClearButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground cursor-pointer"
    >
      <X size={12} />
    </button>
  );
}

/** Tooltip-wrapped "select all" checkbox shared by the filter bar + toolbar. */
function SelectAllControl({
  checked,
  disabled,
  onToggle,
}: {
  checked: boolean;
  disabled?: boolean;
  onToggle: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="flex shrink-0 items-center px-1.5"
          onClick={(e) => e.stopPropagation()}
        >
          <Checkbox
            checked={checked}
            disabled={disabled}
            onCheckedChange={() => onToggle()}
            aria-label={checked ? "Deselect all posts" : "Select all posts"}
          />
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {checked ? "Deselect all" : "Select all"}
      </TooltipContent>
    </Tooltip>
  );
}

function PostSelectionToolbar({
  count,
  allSelected,
  onToggleSelectAll,
  onUpdateCategory,
  onDelete,
  onExit,
}: {
  count: number;
  allSelected: boolean;
  onToggleSelectAll: () => void;
  onUpdateCategory: () => void;
  onDelete: () => void;
  onExit: () => void;
}) {
  return (
    <div className="flex items-center gap-0.5 border-b bg-accent/40 px-2 py-1.5">
      <SelectAllControl checked={allSelected} onToggle={onToggleSelectAll} />
      <span className="text-xs font-medium tabular-nums">{count} selected</span>
      <div className="ml-auto flex items-center gap-0.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 gap-1 px-2 text-xs"
              onClick={onUpdateCategory}
              aria-label="Set the category for the selected posts"
            >
              <Tag01 size={14} />
              Set category
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            Set the category for the selected posts
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-destructive hover:text-destructive"
              onClick={onDelete}
              aria-label="Delete selected posts"
            >
              <Trash01 size={14} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Delete selected</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={onExit}
              aria-label="Exit selection"
            >
              <X size={14} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Exit selection</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}

/**
 * Dialog for the bulk "Update category" action: pick a category, then choose
 * whether to add it (keeping existing categories) or replace all categories
 * with it (a one-step migration). Holds its own selection/mode state so the
 * parent only deals with the final apply.
 */
function BulkCategoryDialog({
  count,
  categories,
  isPending,
  onApply,
  onOpenChange,
}: {
  count: number;
  categories: CategoryRef[];
  isPending: boolean;
  onApply: (mode: "add" | "replace", category: CategoryRef) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const [slug, setSlug] = useState<string>(categories[0]?.slug ?? "");
  const [mode, setMode] = useState<"add" | "replace">("add");
  const selected = categories.find((c) => c.slug === slug);

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Update category</DialogTitle>
          <DialogDescription>
            Choose a category to apply to {count}{" "}
            {count === 1 ? "post" : "posts"}.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label>Category</Label>
            {categories.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No categories yet — create one in the Categories collection.
              </p>
            ) : (
              <Select value={slug} onValueChange={setSlug}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select a category" />
                </SelectTrigger>
                <SelectContent>
                  {categories.map((c) => (
                    <SelectItem key={c.slug} value={c.slug}>
                      <span className="truncate">{c.name}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          <RadioGroup
            value={mode}
            onValueChange={(v) => setMode(v as "add" | "replace")}
            className="gap-2"
          >
            <Label
              htmlFor="cat-mode-add"
              className="flex cursor-pointer items-start gap-2.5 rounded-lg border p-3"
            >
              <RadioGroupItem
                value="add"
                id="cat-mode-add"
                className="mt-0.5"
              />
              <span className="space-y-0.5">
                <span className="block text-sm font-medium">Add category</span>
                <span className="block text-xs text-muted-foreground">
                  Keep existing categories and add this one.
                </span>
              </span>
            </Label>
            <Label
              htmlFor="cat-mode-replace"
              className="flex cursor-pointer items-start gap-2.5 rounded-lg border p-3"
            >
              <RadioGroupItem
                value="replace"
                id="cat-mode-replace"
                className="mt-0.5"
              />
              <span className="space-y-0.5">
                <span className="block text-sm font-medium">
                  Replace category
                </span>
                <span className="block text-xs text-muted-foreground">
                  Remove all current categories and set only this one.
                </span>
              </span>
            </Label>
          </RadioGroup>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isPending}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!selected || isPending}
            onClick={() =>
              selected &&
              onApply(mode, { name: selected.name, slug: selected.slug })
            }
          >
            {isPending ? (
              <>
                <Loading01 size={14} className="animate-spin" />
                Updating…
              </>
            ) : (
              "Apply"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ItemRow({
  icon: Icon,
  logoUrl,
  title,
  subtitle,
  active,
  accent,
  variantCount,
  trailing,
  selectable,
  selectionActive,
  selected,
  onToggleSelect,
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
  /** "global" tints the row purple to mark a saved/global section. */
  accent?: "global";
  variantCount?: number;
  trailing?: React.ReactNode;
  selectable?: boolean;
  /** In selection mode the checkbox is always shown (not just on hover). */
  selectionActive?: boolean;
  selected?: boolean;
  onToggleSelect?: () => void;
  onClick: () => void;
  menu?: React.ReactNode;
}) {
  const isGlobal = accent === "global";
  const rowIcon =
    variantCount && variantCount > 1 ? (
      <span className="flex size-8 shrink-0 items-center justify-center">
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
      </span>
    ) : logoUrl ? (
      <img
        src={logoUrl}
        alt=""
        className="size-8 shrink-0 rounded-lg object-cover bg-muted"
      />
    ) : (
      <span
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-lg",
          isGlobal ? "bg-global-section/15" : "bg-muted",
        )}
      >
        <Icon
          size={16}
          className={cn(
            "shrink-0",
            !isGlobal &&
              (active ? "text-accent-foreground" : "text-muted-foreground"),
          )}
          style={isGlobal ? { color: GLOBAL_SECTION_ICON_COLOR } : undefined}
        />
      </span>
    );

  return (
    <div
      className={cn(
        "group relative flex min-w-0 items-center rounded-md transition-colors",
        active
          ? isGlobal
            ? "bg-global-section/15 text-global-section-fg dark:text-global-section-fg-dark"
            : "bg-accent text-accent-foreground"
          : isGlobal
            ? "hover:bg-global-section/10"
            : "hover:bg-muted",
      )}
    >
      {selectable && (
        <span
          className={cn(
            "flex shrink-0 items-center pl-2.5 transition-opacity",
            selected || selectionActive
              ? "opacity-100"
              : "opacity-0 group-hover:opacity-100 focus-within:opacity-100",
          )}
          onClick={(e) => e.stopPropagation()}
        >
          <Checkbox
            checked={selected}
            onCheckedChange={() => onToggleSelect?.()}
            aria-label={`Select ${title}`}
          />
        </span>
      )}
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

export function ListEmpty({
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

export function EmptyMessage({
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
