import { sleep } from "@decocms/std";
import { useState, useRef, useEffect, Suspense, lazy } from "react";
import { useNavigate } from "@tanstack/react-router";
import { formatCodeTabId } from "@/web/layouts/main-panel-tabs/tab-id";
import { useChatTask } from "@/web/components/chat/context";
import { useProjectContext } from "@decocms/mesh-sdk";
import { useSandboxLifecycle } from "@/web/components/sandbox/hooks/sandbox-lifecycle-context";
import { useIsMobile } from "@deco/ui/hooks/use-mobile.ts";
import { useT } from "@/web/i18n/use-t.ts";
import type { TranslationKey } from "@/web/i18n/use-t.ts";

import {
  ChevronDown,
  Code01,
  CursorClick01,
  DotsHorizontal,
  Globe02,
  LayoutAlt01,
  LinkExternal01,
  Plus,
  SearchLg,
  CreditCardSearch,
  TextInput,
  Monitor04,
  Phone02,
  RefreshCw01,
  Tablet01,
} from "@untitledui/icons";
import { cn } from "@deco/ui/lib/utils.js";
import { Button } from "@deco/ui/components/button.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { ToolbarIconButton } from "@/web/components/toolbar-icon-button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@deco/ui/components/dropdown-menu.tsx";
import { useDecofile } from "@/web/components/sections-editor/use-decofile";
import { withVariantMatcherOverride } from "@/web/components/sections-editor/variant-matcher-override";
import { useLiveMeta } from "@/web/components/sections-editor/use-live-meta";
import {
  extractGlobalSections,
  extractPages,
  findPageForPath,
  type GlobalSectionEntry,
  type PageEntry,
} from "@/web/components/sections-editor/page-list";
import {
  fillPathTemplate,
  normalizePagePath,
  splitPathTemplate,
  validatePagePath,
} from "@/web/components/sections-editor/page-path-utils";
import { decoBlockFileViewPath } from "@/web/components/sections-editor/deco-block-key";
import { findLivePageResolveType } from "@/web/components/sections-editor/section-catalog";
import { buildGlobalSectionPreviewUrl } from "@/web/components/sections-editor/section-preview-url";
import { useCreatePage } from "@/web/components/sections-editor/use-create-page";
import { CreatePageModal } from "@/web/components/sections-editor/create-page-modal";
import { toast } from "sonner";
import {
  VISUAL_EDITOR_SCRIPT,
  VisualEditorPayloadSchema,
  type VisualEditorPayload,
} from "./visual-editor-script";
import { CMS_EDITOR_SCRIPT, CmsEditorPayloadSchema } from "./cms-editor-script";
import { parseSections } from "@/web/components/sections-editor/parse-sections";
import { resolveSectionCandidates } from "./section-candidates";
import { getPageVariantSectionsAt } from "@/web/components/sections-editor/page-variants";
import { VisualEditorPrompt } from "./visual-editor-prompt";
import {
  useSandboxEvents,
  useSandboxReloadHandler,
  useSandboxReloadStartHandler,
} from "../hooks/use-sandbox-events";
import { SandboxStateCard } from "./state-card";
import {
  lastPreviewPageKey,
  readLastPreviewPage,
  writeLastPreviewPage,
  type LastPreviewPage,
} from "./last-preview-page";
import { derivePhaseProgress } from "./derive-phase-progress";
import { ideDeepLink } from "../ide-deep-link";
import {
  classifyParamKinds,
  collectPageLoaderResolveTypes,
  commercePlatformsFromLoaders,
  resolveOptionSources,
  type OptionSource,
} from "./path-param-picker";
import {
  PathParamAutoFill,
  PathParamPickerChip,
} from "./path-param-picker-chip";
import { PathParamInput } from "./path-param-input";
import { manifestLoaderResolveTypes } from "@/web/components/sandbox/content/runnable-catalog";
import { track } from "@/web/lib/posthog-client";
import { useSandboxRepoDir } from "../hooks/use-sandbox-repo-dir";
import { useBlocksPreviewWorkspace } from "@/web/components/sandbox/blocks/blocks-preview-workspace-context";
import { BlocksPanel } from "@/web/components/sandbox/blocks/blocks-panel";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  type ImperativePanelHandle,
} from "@/web/components/resizable";
import {
  togglePreviewEditorMode,
  type PreviewEditingMode,
  type PreviewEditorMode,
} from "./editing-mode";

const VSCODE_ICON_URL =
  "https://decoims.com/decocms/01b321bd-4613-4b2c-9348-35058444d210/Visual_Studio_Code_1.35_icon.svg.png";
const CURSOR_ICON_URL =
  "https://decoims.com/decocms/7583d3b5-81d0-4afb-becf-6a59bbb3a68e/cursor-logo-icon-freelogovectors.net_.png";

const SeoSheet = lazy(() =>
  import("@/web/components/sections-editor/page-seo-sheet").then((m) => ({
    default: m.SeoSheet,
  })),
);

/** Delay before reloading the preview iframe after a save, giving the dev server time to pick up file changes. */
const DEV_SERVER_SETTLE_MS = 500;

type PreviewDeviceSize = "mobile" | "tablet" | "desktop";

const PREVIEW_DEVICE_WIDTHS: Record<PreviewDeviceSize, number | null> = {
  mobile: 375,
  tablet: 768,
  desktop: null,
};

const DEVICE_CYCLE: PreviewDeviceSize[] = ["desktop", "mobile", "tablet"];

// Device labels are resolved per-render in the component to use t()
const DEVICE_LABEL_KEYS: Record<PreviewDeviceSize, TranslationKey> = {
  mobile: "sandbox.preview.deviceMobile",
  tablet: "sandbox.preview.deviceTablet",
  desktop: "sandbox.preview.deviceDesktop",
};

/** Deco reads `deviceHint` to force SSR device matchers (see deco `deviceOf`). */
function withDeviceHint(url: string, device: PreviewDeviceSize): string {
  const parsed = new URL(url, window.location.href);
  parsed.searchParams.set("deviceHint", device);
  return parsed.href;
}

/** Origin of the preview iframe's own site, or `null` if `previewUrl` is unset/invalid. */
function previewOrigin(previewUrl: string | null): string | null {
  if (!previewUrl) return null;
  try {
    return new URL(previewUrl, window.location.href).origin;
  } catch {
    return null;
  }
}

/**
 * Reload the iframe in place; falls back to reassigning `src` when the
 * iframe's live location is cross-origin (sandbox preview domain) and
 * `.reload()` throws.
 */
function reloadIframeOrFallback(
  iframe: HTMLIFrameElement,
  fallbackSrc: string | null,
) {
  try {
    iframe.contentWindow?.location.reload();
  } catch {
    if (fallbackSrc) iframe.src = fallbackSrc;
  }
}

export function PreviewContent({ virtualMcpId }: { virtualMcpId: string }) {
  const t = useT();
  const isMobile = useIsMobile();
  const navigate = useNavigate();
  const { currentBranch: branch } = useChatTask();
  const workspace = useBlocksPreviewWorkspace();

  const goToTab = (main: string) => {
    navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({ ...prev, main }),
      replace: true,
    });
  };

  // Editing mode is singular: Visual editor and Blocks cannot be active
  // together. Device size is independent and survives mode switches.
  const [editingMode, setEditingMode] = useState<PreviewEditingMode>("preview");
  const [previewDeviceSize, setPreviewDeviceSize] =
    useState<PreviewDeviceSize>("desktop");
  const [visualElement, setVisualElement] =
    useState<VisualEditorPayload | null>(null);
  /** Section index selected via click-through from the preview iframe. */
  const [cmsSelectedSectionIndex, setCmsSelectedSectionIndex] = useState<
    number | null
  >(null);
  const previewIframeRef = useRef<HTMLIFrameElement>(null);
  const blocksPanelRef = useRef<ImperativePanelHandle>(null);

  // Pages dropdown in URL bar
  const [pagesOpen, setPagesOpen] = useState(false);
  const [pagesSearch, setPagesSearch] = useState("");
  const pagesContainerRef = useRef<HTMLDivElement>(null);
  const [createPageDialogOpen, setCreatePageDialogOpen] = useState(false);
  const [createPageError, setCreatePageError] = useState<string | undefined>();
  const [activeGlobalSection, setActiveGlobalSection] =
    useState<GlobalSectionEntry | null>(null);
  /** Overrides iframe src for global-section live previews (stable URL, not recomputed). */
  const [directPreviewUrl, setDirectPreviewUrl] = useState<string | null>(null);

  // Current iframe path (for sections editor)
  const [currentPath, setCurrentPath] = useState("/");
  /** Explicit page block key from the page picker; disambiguates duplicate paths. */
  const [pinnedPageKey, setPinnedPageKey] = useState<string | null>(null);
  /** User-provided values for `:param` tokens in path templates, keyed by page block key. */
  const [pathParamsByPage, setPathParamsByPage] = useState<
    Record<string, Record<string, string>>
  >({});

  // Instant click feedback: set the moment a page/section is picked, cleared
  // when the iframe's onLoad fires. Without this the click has no visible
  // effect until the new page finishes fetching, so it feels unresponsive.
  const [navigating, setNavigating] = useState(false);
  const navTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const beginNavigation = () => {
    setNavigating(true);
    if (navTimerRef.current) clearTimeout(navTimerRef.current);
    // Safety net: clear the indicator even if onLoad never fires (network
    // failure, cross-origin redirect) so it can't get stuck on forever.
    navTimerRef.current = setTimeout(() => setNavigating(false), 15000);
  };
  const endNavigation = () => {
    if (navTimerRef.current) {
      clearTimeout(navTimerRef.current);
      navTimerRef.current = null;
    }
    setNavigating(false);
  };

  // SEO panel state
  const [siteSeoOpen, setSiteSeoOpen] = useState(false);

  const { org } = useProjectContext();

  const vmEvents = useSandboxEvents();
  const lifecycle = useSandboxLifecycle();
  const vmEntry = lifecycle.vmEntry;
  const previewUrl = lifecycle.previewUrl;
  const lifecyclePhase = vmEvents.lifecycle.phase;
  const devServerReady = lifecyclePhase === "running";

  const isDesktopSandbox = vmEntry?.sandboxProviderKind === "user-desktop";
  const rawRepoDir = useSandboxRepoDir({
    orgSlug: org.slug,
    virtualMcpId: virtualMcpId ?? "",
    branch: branch ?? "",
    enabled: isDesktopSandbox && devServerReady && !!virtualMcpId && !!branch,
  });
  // Guard the value, not just the query: React Query's staleTime=Infinity cache
  // can retain a stale repoDir after the provider kind changes from desktop to
  // agent-sandbox, whose daemon reports a container-internal path ("/app/repo").
  const repoDir = isDesktopSandbox ? rawRepoDir : null;

  // Decofile pages/global sections for the URL bar dropdown. Not gated on the
  // dev server: when it's down we read the committed `.deco/*.gen.json` snapshot
  // so the dropdown still lists pages; the live routes take over once it's up.
  // (The inline CMS overlay still needs the dev server — it edits the page
  // rendered inside the iframe, which the dev server serves.)
  const decofileParams =
    virtualMcpId && branch
      ? { orgSlug: org.slug, virtualMcpId, branch, previewUrl }
      : null;
  const { data: decofile } = useDecofile(decofileParams, {
    fetchEnabled: devServerReady,
  });
  const { data: meta } = useLiveMeta(decofileParams, {
    fetchEnabled: devServerReady,
  });
  const createPageParams =
    virtualMcpId && branch ? { orgSlug: org.slug, virtualMcpId, branch } : null;
  const createPage = useCreatePage(createPageParams);
  const pages = decofile
    ? extractPages(decofile).sort((a, b) => a.name.localeCompare(b.name))
    : [];
  const globalSections =
    decofile && meta ? extractGlobalSections(decofile, meta) : [];
  const normPath = normalizePagePath;
  const filteredPages = pages.filter((page) => {
    if (!pagesSearch) return true;
    const q = pagesSearch.toLowerCase();
    return (
      page.name.toLowerCase().includes(q) || page.path.toLowerCase().includes(q)
    );
  });
  const filteredGlobalSections = globalSections.filter((section) => {
    if (!pagesSearch) return true;
    const q = pagesSearch.toLowerCase();
    return (
      section.name.toLowerCase().includes(q) ||
      section.key.toLowerCase().includes(q) ||
      section.resolveType.toLowerCase().includes(q)
    );
  });
  const currentPage = activeGlobalSection
    ? null
    : findPageForPath(pages, currentPath, pinnedPageKey);
  const currentPageName = activeGlobalSection
    ? activeGlobalSection.name
    : currentPage?.name;
  const currentPageKey = currentPage?.key ?? null;
  const currentPagePath = currentPage?.path ?? null;

  // Path templates: pages like `/blog/:slug` expose inline inputs in the URL
  // bar. `currentPath` keeps the template (so the page stays matched); the
  // iframe navigates to the template with the user's values filled in.
  const pathParamValues =
    (currentPageKey ? pathParamsByPage[currentPageKey] : undefined) ?? {};
  const resolvedPath = fillPathTemplate(currentPath, pathParamValues);

  // Special selectors for path params: each `:param`/`*` is classified from the
  // loaders the current page uses (product/category, app-agnostic) and bound to
  // whatever product-search / category loader the running site actually ships.
  // A param with no resolvable source keeps the plain inline input.
  const pathParamSources: Record<string, OptionSource[]> = {};
  if (devServerReady && previewUrl && meta && decofile) {
    const manifestLoaders = manifestLoaderResolveTypes(meta, "loaders");
    const pageBlock = currentPageKey ? decofile[currentPageKey] : undefined;
    const pageLoaders = collectPageLoaderResolveTypes(
      pageBlock,
      decofile,
      (rt) => manifestLoaders.has(rt),
    );
    // The page's commerce platform (e.g. magento) — so option sources don't
    // invoke a competing vendor's loader that merely exists in the manifest.
    const platforms = commercePlatformsFromLoaders(pageLoaders);
    for (const token of splitPathTemplate(currentPath)) {
      if (token.type !== "param") continue;
      const kinds = classifyParamKinds(currentPath, token.name, pageLoaders);
      const sources = resolveOptionSources(kinds, manifestLoaders, platforms);
      if (sources.length > 0) pathParamSources[token.name] = sources;
    }
  }
  const pickerSandboxRef =
    virtualMcpId && branch ? { orgSlug: org.slug, virtualMcpId, branch } : null;

  // Per-section metadata for the CMS hover overlay, aligned by index with the
  // iframe's top-level section list. `label`: ONLY global (saved block)
  // sections get a name — the DOM can't carry it (incl. globals inside async
  // rendering); non-global sections are empty so the iframe falls back to their
  // full resolve. `kind`: drives the highlight color (global / variant / normal).
  const cmsRawSections =
    decofile && currentPageKey
      ? getPageVariantSectionsAt(decofile, currentPageKey, 0)
      : [];
  const cmsSections = decofile ? parseSections(cmsRawSections, decofile) : [];
  const cmsSectionLabels = cmsSections.map((s) =>
    s.isSavedBlock ? s.label : "",
  );
  const cmsSectionKinds = cmsSections.map((s) =>
    s.isSavedBlock ? "global" : s.isMultivariate ? "variant" : "normal",
  );
  // Candidate manifest keys per editable section, used iframe-side to align the
  // editable run within the DOM (handles framework sections deco injects around
  // OR between the editable ones) — no hardcoded list of sections to skip.
  const cmsSectionKeys = cmsRawSections.map((s) =>
    resolveSectionCandidates(s, decofile ?? {}),
  );

  const iframeSrcRef = useRef<string | null>(null);
  /** Path we navigated to programmatically; ignore stale iframe onLoad events. */
  const intendedPathRef = useRef<string | null>(null);

  // Only the user-pause state routes to the suspended overlay (resume
  // affordance). The daemon's `error` state means the dev script crashed
  // — that's a failure, but the daemon's HTTP proxy serves an auto-reloading
  // HTML page for it, so the iframe surfaces it; no dedicated overlay.
  const appPaused = vmEvents.status.state === "paused";

  const claimPhase = vmEvents.phase;

  const progress = derivePhaseProgress({
    claimPhase,
    lifecycle: vmEvents.lifecycle,
  });

  const previewState = lifecycle.previewState;
  const userStopped = lifecycle.userStopped;

  // The recorded previewUrl flips previewState to "iframe" as soon as the
  // sandbox handle exists — well before the public preview proxy is routable
  // and actually serving, so the iframe renders blank during the initial boot.
  // Keep the booting visual overlaid (absolute, z-30, above the warming iframe)
  // until the dev server has come up. `progress.status === "doing"` is true for
  // exactly the forward boot phases (provision → clone → install → starting);
  // it flips to "done" at `running` and "failed" on a terminal error, so both
  // the live app and the daemon's auto-reloading status/crash page still fall
  // through to the iframe unobscured.
  const showBootingOverlay =
    previewState.kind === "starting" ||
    (previewState.kind === "iframe" && progress.status === "doing");

  const iframeSrc =
    previewState.kind === "iframe"
      ? withVariantMatcherOverride(
          withDeviceHint(
            directPreviewUrl ??
              new URL(resolvedPath, previewState.previewUrl).href,
            previewDeviceSize,
          ),
          workspace.state.variantOverride ?? [],
        )
      : null;

  // Last visited page (incl. `:param` values), persisted per project+branch.
  const previewStorageKey =
    virtualMcpId && branch
      ? lastPreviewPageKey(org.slug, virtualMcpId, branch)
      : null;
  const persistLastPage = (page: LastPreviewPage) => {
    if (previewStorageKey) writeLastPreviewPage(previewStorageKey, page);
  };

  const sharedTarget = workspace.state.target;
  // oxlint-disable-next-line ban-use-effect/ban-use-effect -- synchronizes the independent Blocks selection with the mounted Preview iframe
  useEffect(() => {
    if (!sharedTarget || !previewUrl || !meta) return;
    if (sharedTarget.kind === "page") {
      const params = pathParamsByPage[sharedTarget.key] ?? {};
      intendedPathRef.current = fillPathTemplate(sharedTarget.path, params);
      setActiveGlobalSection(null);
      setDirectPreviewUrl(null);
      setPinnedPageKey(sharedTarget.key);
      setCurrentPath(sharedTarget.path);
      persistLastPage({
        path: sharedTarget.path,
        pageKey: sharedTarget.key,
        params,
      });
    } else {
      const section = globalSections.find(
        (candidate) => candidate.key === sharedTarget.key,
      );
      if (section) {
        intendedPathRef.current = null;
        const livePageRt = findLivePageResolveType(meta);
        setActiveGlobalSection(section);
        setDirectPreviewUrl(
          buildGlobalSectionPreviewUrl(previewUrl, livePageRt, section.key),
        );
      }
    }
    // oxlint-disable-next-line eslint-plugin-react-hooks/exhaustive-deps -- derived helpers must not retrigger selection synchronization every render
  }, [sharedTarget, previewUrl, meta, pathParamsByPage]);

  // Publish the page Preview is showing to the shared workspace so the Blocks
  // panel follows it — Blocks has no page navigator, it edits whatever page
  // Preview is on. navigatePreviewToPage already publishes on explicit page
  // switches; this covers the initial restore (last visited page), where
  // pinnedPageKey is set but the target was never published. Guarded against
  // the target→Preview sync above: dispatches only when the current page
  // actually differs from the target, so the two effects converge, never loop.
  // oxlint-disable-next-line ban-use-effect/ban-use-effect -- publishes Preview's current page to the shared Blocks selection
  useEffect(() => {
    if (!currentPageKey || currentPagePath === null) return;
    if (
      sharedTarget?.kind === "page" &&
      sharedTarget.key === currentPageKey &&
      sharedTarget.path === currentPagePath
    ) {
      return;
    }
    workspace.selectTarget({
      kind: "page",
      key: currentPageKey,
      path: currentPagePath,
    });
    // oxlint-disable-next-line eslint-plugin-react-hooks/exhaustive-deps -- workspace handle is recreated each render; publish keyed on page + target only
  }, [currentPageKey, currentPagePath, sharedTarget]);

  // When the VM preview base URL appears or changes (first boot, branch
  // switch, etc.), restore the last visited page for this project+branch;
  // reset navigation to "/" when there's nothing saved.
  const [prevIframeBase, setPrevIframeBase] = useState<string | null>(null);
  if (
    previewState.kind === "iframe" &&
    prevIframeBase !== previewState.previewUrl
  ) {
    const hadPreviousBase = prevIframeBase !== null;
    setPrevIframeBase(previewState.previewUrl);
    const saved = previewStorageKey
      ? readLastPreviewPage(previewStorageKey)
      : null;
    if (saved) {
      // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- expect the restored page's resolved path on the next iframe load
      intendedPathRef.current = fillPathTemplate(saved.path, saved.params);
      setCurrentPath(saved.path);
      setPinnedPageKey(saved.pageKey);
      setDirectPreviewUrl(null);
      setActiveGlobalSection(null);
      if (saved.pageKey && Object.keys(saved.params).length > 0) {
        const pageKey = saved.pageKey;
        setPathParamsByPage((prev) => ({ ...prev, [pageKey]: saved.params }));
      }
    } else if (hadPreviousBase) {
      // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- clear stale navigation intent on branch switch
      intendedPathRef.current = null;
      setCurrentPath("/");
      setDirectPreviewUrl(null);
      setPinnedPageKey(null);
      setActiveGlobalSection(null);
    }
  }

  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- ref read in reload handler
  iframeSrcRef.current = iframeSrc;

  // Daemon is reachable independent of the dev script: ready claim, handle
  // still present, not user-stopped. Gates surfaces (FileExplorer,
  // terminal) that talk to the daemon's HTTP API and don't need a dev server.
  const daemonReady =
    !!virtualMcpId &&
    !!branch &&
    !vmEvents.notFound &&
    !userStopped &&
    !appPaused &&
    (claimPhase?.kind === "ready" || lifecyclePhase !== "idle");

  // Visual mode requires a live iframe. Blocks can stay open while the
  // sandbox restarts so its loading/error state remains actionable.
  const effectiveEditingMode: PreviewEditingMode =
    previewState.kind !== "iframe" && editingMode === "visual"
      ? "preview"
      : editingMode;

  // oxlint-disable-next-line ban-use-effect/ban-use-effect — DOM event subscription
  useEffect(() => {
    const allowedOrigin = previewOrigin(previewUrl);
    if (!allowedOrigin) return;
    const handler = (e: MessageEvent) => {
      if (e.origin !== allowedOrigin) return;
      if (e.data?.type === "visual-editor::element-clicked") {
        const result = VisualEditorPayloadSchema.safeParse(e.data.payload);
        if (result.success) setVisualElement(result.data);
      } else if (e.data?.type === "cms-editor::section-clicked") {
        const result = CmsEditorPayloadSchema.safeParse(e.data.payload);
        if (result.success)
          setCmsSelectedSectionIndex(result.data.sectionIndex);
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [previewUrl]);

  // Close pages dropdown on outside click
  // oxlint-disable-next-line ban-use-effect/ban-use-effect — DOM event subscription for outside-click dismiss
  useEffect(() => {
    if (!pagesOpen) return;
    const handler = (e: PointerEvent) => {
      if (!pagesContainerRef.current?.contains(e.target as Node)) {
        setPagesOpen(false);
        setPagesSearch("");
      }
    };
    document.addEventListener("pointerdown", handler);
    return () => document.removeEventListener("pointerdown", handler);
  }, [pagesOpen]);

  // Target origin is pinned to the preview site itself: with "*" the parent
  // would still hand the editor script and page-structure metadata to
  // whatever origin currently occupies the iframe if it cross-navigated away.
  const injectVisualEditor = () => {
    const win = previewIframeRef.current?.contentWindow;
    const origin = previewOrigin(previewUrl);
    if (!win || !origin) return;
    win.postMessage(
      { type: "visual-editor::activate", script: VISUAL_EDITOR_SCRIPT },
      origin,
    );
  };

  const deactivateVisualEditor = () => {
    const win = previewIframeRef.current?.contentWindow;
    const origin = previewOrigin(previewUrl);
    if (!win || !origin) return;
    win.postMessage({ type: "visual-editor::deactivate" }, origin);
  };

  const injectCmsEditor = () => {
    const win = previewIframeRef.current?.contentWindow;
    const origin = previewOrigin(previewUrl);
    if (!win || !origin) return;
    win.postMessage(
      { type: "visual-editor::activate", script: CMS_EDITOR_SCRIPT },
      origin,
    );
    // Ordered after activate, so the script's listener is registered by the
    // time this arrives. Re-sent on every (re)injection (mode switch, page
    // navigation, save-reload) so labels track the current page.
    win.postMessage(
      {
        type: "cms-editor::set-labels",
        labels: cmsSectionLabels,
        kinds: cmsSectionKinds,
        keys: cmsSectionKeys,
      },
      origin,
    );
  };

  const deactivateCmsEditor = () => {
    const win = previewIframeRef.current?.contentWindow;
    const origin = previewOrigin(previewUrl);
    if (!win || !origin) return;
    win.postMessage({ type: "cms-editor::deactivate" }, origin);
  };

  const activateEditingMode = (mode: PreviewEditingMode) => {
    const previousMode = editingMode;
    if (!isMobile && mode !== previousMode) {
      if (mode === "blocks") blocksPanelRef.current?.resize(30);
      else blocksPanelRef.current?.collapse();
    }
    setEditingMode(mode);
    setVisualElement(null);
    setCmsSelectedSectionIndex(null);
    if (previousMode === "visual") deactivateVisualEditor();
    if (mode === "visual") injectVisualEditor();
    if (previousMode === "blocks" && mode !== "blocks") deactivateCmsEditor();
    if (mode === "blocks") injectCmsEditor();
  };

  const toggleEditingMode = (mode: PreviewEditorMode) => {
    activateEditingMode(togglePreviewEditorMode(editingMode, mode));
  };

  const handleRefresh = () => {
    if (!previewIframeRef.current || !iframeSrc) return;
    const iframe = previewIframeRef.current;
    // biome-ignore lint/correctness/noSelfAssign: reloads the iframe
    // oxlint-disable-next-line no-self-assign
    iframe.src = iframeSrc;
  };

  // Reload the preview without moving keyboard focus. Used both for the daemon
  // "reload" event (config edits HMR won't catch) and, via the debounced
  // `.deco/` file-changed signal, after a Blocks save once the dev server has
  // rebuilt (see sandbox-events-context).
  const reloadPreviewPreservingScroll = () => {
    const iframe = previewIframeRef.current;
    if (!iframe) return;
    // Show the same loading overlay as page navigation while the reloaded page
    // fetches; the iframe's onLoad clears it (with beginNavigation's safety net
    // as a fallback if onLoad never fires).
    beginNavigation();
    const focused = document.activeElement as HTMLElement | null;
    const prevTabIndex = iframe.tabIndex;
    iframe.tabIndex = -1;
    iframe.style.pointerEvents = "none";
    iframe.blur();
    reloadIframeOrFallback(iframe, iframeSrcRef.current);
    let fallbackTimer: ReturnType<typeof setTimeout>;
    const restore = () => {
      clearTimeout(fallbackTimer);
      iframe.tabIndex = prevTabIndex;
      iframe.style.pointerEvents = "";
      // Only restore focus if the reload itself stole it (focus was on/inside the
      // iframe, so blurring it dropped focus to <body>). If the user has since
      // moved to another element — e.g. tabbed from a date field to a text input
      // in the Blocks form while the debounced save-reload was in flight — leave
      // it there; re-focusing `focused` would yank them back to the stale field.
      const active = document.activeElement;
      if (!active || active === document.body || active === iframe) {
        focused?.focus();
      }
      iframe.removeEventListener("load", restore);
    };
    iframe.addEventListener("load", restore);
    // Safety net only — cleared above once `load` fires first, so `restore`
    // (and its focus() steal) can't fire a second time 3s after a normal load.
    fallbackTimer = setTimeout(restore, 3000);
  };

  // Fires on the daemon "reload" event and on debounced `.deco/` file changes
  // (Blocks saves, external/agent decofile writes) — the only refresh path for
  // decofile edits, which the framework's HMR doesn't cover.
  useSandboxReloadHandler(() => {
    reloadPreviewPreservingScroll();
  });
  // Show the loading overlay the instant a `.deco/` change is detected, ahead of
  // the debounced reload above, so the pending refresh feels immediate.
  useSandboxReloadStartHandler(() => {
    beginNavigation();
  });

  const handleHardReload = () => {
    if (!previewIframeRef.current || !iframeSrc) return;
    const sep = iframeSrc.includes("?") ? "&" : "?";
    previewIframeRef.current.src = `${iframeSrc}${sep}_r=${Date.now()}`;
  };

  const handleDeviceToggle = () => {
    const idx = DEVICE_CYCLE.indexOf(previewDeviceSize);
    setPreviewDeviceSize(DEVICE_CYCLE[(idx + 1) % DEVICE_CYCLE.length]!);
  };

  const handleCopyUrl = async () => {
    // The iframe's live location is cross-origin (sandbox preview domain), so
    // reading `.location.href` throws — same reason the onLoad handler below
    // guards the analogous `.pathname` read.
    let liveUrl: string | null = null;
    try {
      liveUrl = previewIframeRef.current?.contentWindow?.location?.href ?? null;
    } catch {
      // Cross-origin — fall back below.
    }
    const url = liveUrl ?? iframeSrc ?? previewUrl;
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      toast.success(t("sandbox.preview.urlCopiedToClipboard"));
    } catch {
      toast.error(t("sandbox.preview.failedToCopyUrl"));
    }
  };

  const previewLabel = (() => {
    if (!previewUrl) return t("sandbox.preview.noServerRunning");
    if (activeGlobalSection) return activeGlobalSection.name;
    try {
      const url = new URL(previewUrl);
      const path = resolvedPath === "/" ? "" : resolvedPath;
      return `${url.host}${path}`;
    } catch {
      return previewUrl;
    }
  })();

  const navigatePreviewToPage = (page: PageEntry) => {
    // The iframe loads the template with any stored param values filled in.
    const params = pathParamsByPage[page.key] ?? {};
    const target = fillPathTemplate(page.path, params);
    // Show the loading indicator only when the iframe will actually reload —
    // re-selecting the current page leaves `iframeSrc` unchanged (no onLoad).
    if (activeGlobalSection || normPath(target) !== normPath(resolvedPath)) {
      beginNavigation();
    }
    intendedPathRef.current = target;
    setActiveGlobalSection(null);
    setDirectPreviewUrl(null);
    // A click-through index from the previous page must not auto-select on the
    // next page's remounted editor.
    setCmsSelectedSectionIndex(null);
    setPinnedPageKey(page.key);
    setCurrentPath(page.path);
    persistLastPage({ path: page.path, pageKey: page.key, params });
    workspace.selectTarget({
      kind: "page",
      key: page.key,
      path: page.path,
    });
  };

  const setPathParamValue = (name: string, value: string) => {
    if (!currentPageKey) return;
    const pageKey = currentPageKey;
    const nextValues = { ...pathParamValues, [name]: value };
    // Guard against a stale onLoad from the previous URL resetting currentPath.
    intendedPathRef.current = fillPathTemplate(currentPath, nextValues);
    setPathParamsByPage((prev) => ({ ...prev, [pageKey]: nextValues }));
    persistLastPage({ path: currentPath, pageKey, params: nextValues });
  };

  const navigatePreviewToGlobalSection = (section: GlobalSectionEntry) => {
    if (!previewUrl || !meta) {
      toast.error(t("sandbox.preview.previewMetadataNotReady"));
      return;
    }
    beginNavigation();
    intendedPathRef.current = null;
    const livePageRt = findLivePageResolveType(meta);
    const url = buildGlobalSectionPreviewUrl(
      previewUrl,
      livePageRt,
      section.key,
    );
    setActiveGlobalSection(section);
    setDirectPreviewUrl(url);
    setCmsSelectedSectionIndex(null);
    workspace.selectTarget({ kind: "section", key: section.key });
  };

  const handleCreatePage = async ({
    name,
    path,
    templateKey,
  }: {
    name: string;
    path: string;
    templateKey: string | null;
  }) => {
    if (!virtualMcpId || !branch) return;
    const pathError = validatePagePath(path);
    if (pathError) {
      setCreatePageError(pathError);
      return;
    }
    const trimmedPath = path.trim().startsWith("/")
      ? path.trim()
      : `/${path.trim()}`;
    if (pages.some((p) => normPath(p.path) === normPath(trimmedPath))) {
      setCreatePageError(
        t("sandbox.preview.pageAlreadyExists", { path: trimmedPath }),
      );
      return;
    }
    let template: Record<string, unknown> | undefined;
    if (templateKey) {
      template = decofile?.[templateKey] as Record<string, unknown> | undefined;
      if (!template) {
        setCreatePageError(t("sandbox.preview.templateNoLongerExists"));
        return;
      }
    }
    setCreatePageError(undefined);
    try {
      const result = await createPage.mutateAsync({
        name,
        path: trimmedPath,
        template,
      });
      setCreatePageDialogOpen(false);
      toast.success(t("sandbox.preview.pageCreated", { name }));
      await sleep(DEV_SERVER_SETTLE_MS);
      navigatePreviewToPage({
        key: result.key,
        name: result.name,
        path: result.path,
      });
      activateEditingMode("blocks");
    } catch (error) {
      setCreatePageError(
        error instanceof Error
          ? error.message
          : t("sandbox.preview.failedToCreatePage"),
      );
    }
  };

  const canVisualEdit = previewState.kind === "iframe";
  const floatingPreviewControls = canVisualEdit ? (
    <div className="absolute bottom-4 left-1/2 z-20 -translate-x-1/2">
      <div className="flex items-center gap-0.5 rounded-full border bg-background/90 p-1 shadow-lg backdrop-blur-sm">
        <Tooltip>
          <TooltipTrigger asChild>
            <ToolbarIconButton
              onClick={() => toggleEditingMode("visual")}
              aria-pressed={editingMode === "visual"}
              aria-label={t("sandbox.preview.visualEditor")}
              active={editingMode === "visual"}
              disabled={!canVisualEdit}
            >
              <CursorClick01 size={16} />
            </ToolbarIconButton>
          </TooltipTrigger>
          <TooltipContent side="top">
            {t("sandbox.preview.visualEditor")}
          </TooltipContent>
        </Tooltip>
        <div className="mx-0.5 h-5 w-px bg-border" />
        <Tooltip>
          <TooltipTrigger asChild>
            <ToolbarIconButton
              onClick={handleDeviceToggle}
              aria-label={t(DEVICE_LABEL_KEYS[previewDeviceSize])}
              disabled={!canVisualEdit}
            >
              <span
                key={previewDeviceSize}
                className="flex items-center justify-center animate-device-icon-pop"
              >
                {previewDeviceSize === "mobile" && <Phone02 size={16} />}
                {previewDeviceSize === "tablet" && <Tablet01 size={16} />}
                {previewDeviceSize === "desktop" && <Monitor04 size={16} />}
              </span>
            </ToolbarIconButton>
          </TooltipTrigger>
          <TooltipContent side="top">
            {t(DEVICE_LABEL_KEYS[previewDeviceSize])}
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  ) : null;

  return (
    <div className="flex flex-col w-full h-full">
      {/* Auto-select the first entity for a picker param with no value yet, so
          navigating to a bare dynamic-route template lands on a real page.
          Each helper renders nothing and unmounts once its param is filled. */}
      {pickerSandboxRef &&
        Object.entries(pathParamSources).map(([name, sources]) =>
          (pathParamValues[name] ?? "") === "" ? (
            <PathParamAutoFill
              key={`${currentPageKey}:${name}`}
              source={sources[0]!}
              template={currentPath}
              paramName={name}
              sandboxRef={pickerSandboxRef}
              onFill={(value) => setPathParamValue(name, value)}
            />
          ) : null,
        )}
      {daemonReady && previewState.kind === "iframe" && (
        <div className="relative flex h-12 shrink-0 items-center gap-4 border-b border-border/60 px-3 md:px-4">
          {previewState.kind === "iframe" && (
            <div className="flex h-full w-full items-center justify-between gap-2">
              <Button
                variant="outline"
                size="sm"
                data-testid="preview-blocks-toggle"
                onClick={() => toggleEditingMode("blocks")}
                aria-pressed={editingMode === "blocks"}
                aria-label={t("sandbox.preview.blocksEditor")}
              >
                <TextInput size={14} />
                {t("sandbox.preview.blocks")}
              </Button>

              <div className="flex w-full min-w-0 max-w-[500px] items-center gap-0.5">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={handleRefresh}
                      aria-label={t("sandbox.preview.refresh")}
                    >
                      <RefreshCw01 size={14} />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {t("sandbox.preview.refresh")}
                  </TooltipContent>
                </Tooltip>

                <div
                  ref={pagesContainerRef}
                  className="relative min-w-0 flex-1"
                >
                  <div className="flex h-8 w-full min-w-0 items-center rounded-md border border-border bg-background transition-colors duration-200 hover:bg-accent">
                    {/* Not a <button>: path-template pages render `:param`
                        inputs inline, and inputs can't nest inside a button.
                        Keyboard toggling stays on the chevron button. */}
                    <div
                      className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-1 pl-2 pr-1"
                      onClick={() => setPagesOpen((prev) => !prev)}
                    >
                      {activeGlobalSection && (
                        <span className="shrink-0 inline-flex items-center gap-1 rounded bg-global-section/14 px-1.5 py-0.5 text-[11px] font-medium text-global-section-fg dark:text-global-section-fg-dark">
                          <Globe02 size={11} />
                          Global
                        </span>
                      )}
                      {/* Page name in focus, followed by the route path.
                            Path-template segments (`:param`/`*`) stay editable
                            inputs; plain paths render as muted text. */}
                      <span
                        className={cn(
                          "text-[13px] font-medium text-foreground",
                          // A real page name stays fully visible (the route
                          // path truncates instead); the host fallback has no
                          // path segment to shed, so it must truncate itself.
                          currentPageName == null
                            ? "min-w-0 flex-1 truncate"
                            : "shrink-0",
                        )}
                      >
                        {currentPageName ?? previewLabel}
                      </span>
                      {!activeGlobalSection &&
                        currentPageName != null &&
                        currentPath && (
                          <span className="flex min-w-0 flex-1 items-center overflow-hidden whitespace-nowrap text-[12px] text-muted-foreground">
                            {splitPathTemplate(currentPath).map((token, i) => {
                              if (token.type === "text") {
                                return (
                                  <span
                                    key={`text-${i}`}
                                    className={cn(
                                      i === 0 ? "min-w-0 truncate" : "shrink-0",
                                    )}
                                  >
                                    {token.text}
                                  </span>
                                );
                              }
                              const sources = pathParamSources[token.name];
                              // Params with option sources render as a chip that
                              // opens the modal (search or free-form value);
                              // the rest keep the inline input.
                              if (sources && pickerSandboxRef) {
                                return (
                                  <PathParamPickerChip
                                    key={`${currentPageKey}:${token.name}`}
                                    sources={sources}
                                    template={currentPath}
                                    paramName={token.name}
                                    value={pathParamValues[token.name] ?? ""}
                                    sandboxRef={pickerSandboxRef}
                                    onCommit={(value) =>
                                      setPathParamValue(token.name, value)
                                    }
                                  />
                                );
                              }
                              return (
                                <PathParamInput
                                  key={`${currentPageKey}:${token.name}`}
                                  name={token.name}
                                  value={pathParamValues[token.name] ?? ""}
                                  onCommit={(value) =>
                                    setPathParamValue(token.name, value)
                                  }
                                />
                              );
                            })}
                          </span>
                        )}
                    </div>
                    <button
                      type="button"
                      className="flex h-full shrink-0 items-center pl-1 pr-2"
                      onClick={() => setPagesOpen((prev) => !prev)}
                      aria-label={t("sandbox.preview.choosePage")}
                    >
                      <ChevronDown
                        size={12}
                        className={cn(
                          "shrink-0 text-muted-foreground transition-transform",
                          pagesOpen && "rotate-180",
                        )}
                      />
                    </button>
                  </div>

                  {pagesOpen && (
                    <div className="absolute left-0 right-0 top-full z-50 mt-1.5 overflow-hidden rounded-lg border bg-popover shadow-lg">
                      <div className="px-2 h-10 flex items-center gap-2 border-b">
                        <SearchLg
                          size={14}
                          className="shrink-0 text-muted-foreground"
                          aria-hidden
                        />
                        <input
                          type="text"
                          value={pagesSearch}
                          onChange={(e) => setPagesSearch(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key !== "Enter") return;
                            const query = pagesSearch.trim();
                            if (!query) return;
                            // Enter only navigates when the typed path matches an
                            // existing page exactly; otherwise it does nothing.
                            const target = filteredPages.find(
                              (p) => normPath(p.path) === normPath(query),
                            );
                            if (!target) return;
                            e.preventDefault();
                            setPagesOpen(false);
                            setPagesSearch("");
                            navigatePreviewToPage(target);
                          }}
                          placeholder={t(
                            "sandbox.preview.searchPagesAndComponents",
                          )}
                          className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                          autoFocus
                        />
                      </div>
                      <div className="p-1.5 border-b">
                        <button
                          type="button"
                          className="flex w-full items-center gap-2.5 rounded-md px-3 py-2.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
                          onMouseDown={(e) => {
                            e.preventDefault();
                            setPagesOpen(false);
                            setPagesSearch("");
                            setCreatePageError(undefined);
                            setCreatePageDialogOpen(true);
                          }}
                        >
                          <Plus
                            size={16}
                            className="shrink-0 text-muted-foreground"
                          />
                          <span className="flex-1 font-medium">
                            {t("sandbox.preview.createNewPage")}
                          </span>
                        </button>
                      </div>
                      {filteredPages.length === 0 &&
                      filteredGlobalSections.length === 0 ? (
                        <div className="px-4 py-5 text-center text-xs text-muted-foreground">
                          {pages.length === 0 && globalSections.length === 0
                            ? t("sandbox.preview.noPagesFound")
                            : t("sandbox.preview.noSearchResults")}
                        </div>
                      ) : (
                        <div className="max-h-80 overflow-y-auto overscroll-contain">
                          {filteredPages.length > 0 && (
                            <div className="p-1.5">
                              {filteredPages.map((page) => (
                                <button
                                  key={page.key}
                                  type="button"
                                  className="flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
                                  onMouseDown={(e) => {
                                    e.preventDefault();
                                    setPagesOpen(false);
                                    setPagesSearch("");
                                    navigatePreviewToPage(page);
                                  }}
                                >
                                  <LayoutAlt01
                                    size={16}
                                    className="shrink-0 text-muted-foreground"
                                  />
                                  <span className="min-w-0 flex-1 truncate font-medium">
                                    {page.name}
                                  </span>
                                  <span className="shrink-0 text-xs text-muted-foreground">
                                    {page.path}
                                  </span>
                                </button>
                              ))}
                            </div>
                          )}
                          {filteredGlobalSections.length > 0 && (
                            <div
                              className={cn(
                                "p-1.5",
                                filteredPages.length > 0 && "border-t",
                              )}
                            >
                              <div className="px-3 py-2 text-xs font-medium text-muted-foreground">
                                {t("sandbox.preview.globalComponents")}
                              </div>
                              {filteredGlobalSections.map((section) => (
                                <button
                                  key={section.key}
                                  type="button"
                                  className="flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
                                  onMouseDown={(e) => {
                                    e.preventDefault();
                                    setPagesOpen(false);
                                    setPagesSearch("");
                                    navigatePreviewToGlobalSection(section);
                                  }}
                                >
                                  <Globe02
                                    size={16}
                                    className="shrink-0 text-muted-foreground"
                                  />
                                  <span className="min-w-0 flex-1 truncate font-medium">
                                    {section.name}
                                  </span>
                                  <span className="shrink-0 text-xs text-muted-foreground">
                                    {section.resolveType
                                      .split("/")
                                      .pop()
                                      ?.replace(/\.tsx?$/, "")}
                                  </span>
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => {
                        const url = iframeSrc ?? previewState.previewUrl;
                        if (url) window.open(url, "_blank", "noopener");
                      }}
                      aria-label={t("sandbox.preview.openInNewTab")}
                    >
                      <LinkExternal01 size={14} />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {t("sandbox.preview.openInNewTab")}
                  </TooltipContent>
                </Tooltip>
              </div>

              <div className="flex shrink-0 items-center">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t("sandbox.preview.moreOptions")}
                    >
                      <DotsHorizontal size={14} />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-44">
                    <DropdownMenuItem onClick={handleHardReload}>
                      {t("sandbox.preview.hardReload")}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={handleCopyUrl}>
                      {t("sandbox.preview.copyCurrentUrl")}
                    </DropdownMenuItem>
                    {decofile && meta && (
                      <>
                        <DropdownMenuSeparator />
                        {currentPageKey && (
                          <DropdownMenuItem
                            onClick={() => {
                              workspace.editSeo({
                                kind: "page",
                                key: currentPageKey,
                                path: currentPath,
                              });
                              activateEditingMode("blocks");
                            }}
                          >
                            <CreditCardSearch size={14} />
                            {t("sandbox.preview.editSeo")}
                          </DropdownMenuItem>
                        )}
                        {currentPageKey && (
                          <DropdownMenuItem
                            onClick={() => {
                              try {
                                goToTab(
                                  formatCodeTabId(
                                    decoBlockFileViewPath(currentPageKey),
                                  ),
                                );
                              } catch {
                                toast.error(
                                  t("sandbox.preview.invalidPageBlockKey"),
                                );
                              }
                            }}
                          >
                            <Code01 size={14} />
                            {t("sandbox.preview.viewJson")}
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuItem onClick={() => setSiteSeoOpen(true)}>
                          <CreditCardSearch size={14} />
                          {t("sandbox.preview.siteSeo")}
                        </DropdownMenuItem>
                      </>
                    )}
                    {repoDir && (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          onClick={() =>
                            window.open(ideDeepLink("vscode", repoDir))
                          }
                        >
                          <img
                            src={VSCODE_ICON_URL}
                            alt="VSCode"
                            width={14}
                            height={14}
                          />
                          {t("sandbox.preview.openInVscode")}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() =>
                            window.open(ideDeepLink("cursor", repoDir))
                          }
                        >
                          <img
                            src={CURSOR_ICON_URL}
                            alt="Cursor"
                            width={14}
                            height={14}
                          />
                          {t("sandbox.preview.openInCursor")}
                        </DropdownMenuItem>
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="flex-1 overflow-hidden">
        {isMobile && effectiveEditingMode === "blocks" ? (
          <div className="relative h-full min-h-0 overflow-hidden">
            <BlocksPanel
              virtualMcpId={virtualMcpId}
              externalSelectedIndex={cmsSelectedSectionIndex}
            />
            {floatingPreviewControls}
          </div>
        ) : (
          <ResizablePanelGroup direction="horizontal">
            <ResizablePanel
              ref={blocksPanelRef}
              id="preview-blocks-editor"
              order={1}
              defaultSize={effectiveEditingMode === "blocks" ? 30 : 0}
              minSize={20}
              collapsible
              collapsedSize={0}
              className="min-w-0 overflow-hidden"
            >
              {effectiveEditingMode === "blocks" && (
                <BlocksPanel
                  virtualMcpId={virtualMcpId}
                  externalSelectedIndex={cmsSelectedSectionIndex}
                />
              )}
            </ResizablePanel>
            <ResizableHandle
              withHandle
              className={cn(effectiveEditingMode !== "blocks" && "hidden")}
            />
            <ResizablePanel
              id="preview-canvas"
              order={2}
              defaultSize={effectiveEditingMode === "blocks" ? 60 : 100}
              minSize={35}
              className="min-w-0 overflow-hidden"
            >
              <div
                className={cn(
                  "h-full relative overflow-hidden",
                  previewDeviceSize !== "desktop" &&
                    previewState.kind === "iframe" &&
                    "flex justify-center bg-muted/30",
                )}
              >
                {navigating && previewState.kind === "iframe" && (
                  <div className="absolute inset-x-0 top-0 z-40 h-0.5 overflow-hidden bg-primary/15">
                    <div className="absolute inset-y-0 w-2/5 rounded-full bg-primary animate-preview-nav" />
                  </div>
                )}

                {showBootingOverlay && (
                  <div className="absolute inset-0 z-30">
                    <SandboxStateCard
                      kind="starting"
                      progress={progress}
                      claimPhase={claimPhase}
                    />
                  </div>
                )}

                {previewState.kind === "suspended" && (
                  <div className="absolute inset-0 z-30">
                    <SandboxStateCard
                      kind="suspended"
                      onResume={lifecycle.resume}
                    />
                  </div>
                )}

                {previewState.kind === "errored" && (
                  <div className="absolute inset-0 z-30">
                    <SandboxStateCard
                      kind="errored"
                      error={previewState.error}
                      onRetry={lifecycle.retry}
                      connectionsHref={`/${org.slug}/settings/connections`}
                    />
                  </div>
                )}

                {effectiveEditingMode === "visual" && !visualElement && (
                  <div className="absolute top-2 left-1/2 -translate-x-1/2 z-20 flex items-center gap-1.5 rounded-full border border-violet-400/40 bg-violet-500/90 px-3 py-1 text-xs font-medium text-white shadow-md backdrop-blur-sm pointer-events-none select-none">
                    <CursorClick01 size={12} />
                    {t("sandbox.preview.clickElementToAsk")}
                  </div>
                )}
                {effectiveEditingMode === "visual" && visualElement && (
                  <VisualEditorPrompt
                    element={visualElement}
                    onDismiss={() => setVisualElement(null)}
                  />
                )}

                {floatingPreviewControls}

                {previewState.kind === "iframe" && iframeSrc && (
                  <div
                    className={cn(
                      "h-full transition-[width] duration-250 [transition-timing-function:var(--ease-in-out-cubic)]",
                      previewDeviceSize !== "desktop" &&
                        "w-full max-w-full border-x border-border bg-background shadow-sm",
                    )}
                    style={{
                      width:
                        previewDeviceSize === "desktop"
                          ? "100%"
                          : `${PREVIEW_DEVICE_WIDTHS[previewDeviceSize]}px`,
                    }}
                  >
                    <iframe
                      // Key on previewUrl: remount when the VM base URL changes (branch
                      // switch). Path navigation is driven by `iframeSrc` state.
                      key={previewState.previewUrl}
                      ref={previewIframeRef}
                      src={iframeSrc}
                      className="w-full h-full border-0"
                      title={t("sandbox.preview.devServerPreviewTitle")}
                      onLoad={() => {
                        // The page finished loading — always clear the navigation
                        // indicator first, before any of the early returns below.
                        endNavigation();
                        // This is the VM dev-server preview (sandboxed running app),
                        // NOT an MCP app. MCP apps render via <MCPAppRenderer/>.
                        track("vm_preview_loaded", {
                          view_mode: editingMode,
                          vm_id: vmEntry?.sandboxHandle ?? null,
                          // Intentionally excluding the full previewUrl — it can contain
                          // ephemeral tokens / user data in the query string.
                        });
                        // Sync currentPath when the user navigates inside the iframe.
                        // Skip while a programmatic navigation is pending — stale
                        // onLoad events from the previous URL would reset us to "/".
                        if (!activeGlobalSection) {
                          try {
                            const iframePath =
                              previewIframeRef.current?.contentWindow?.location
                                ?.pathname;
                            if (!iframePath) return;
                            const intended = intendedPathRef.current;
                            if (intended !== null) {
                              intendedPathRef.current = null;
                              // Stale onLoad from the previous URL — ignore.
                              if (normPath(iframePath) !== normPath(intended)) {
                                return;
                              }
                            }
                            // Keep the template as currentPath when the loaded
                            // path is just the template with params filled in —
                            // otherwise the page match and param inputs are lost.
                            if (
                              normPath(iframePath) === normPath(resolvedPath)
                            ) {
                              return;
                            }
                            setCurrentPath(iframePath);
                            persistLastPage({
                              path: iframePath,
                              pageKey: pinnedPageKey,
                              params: pathParamValues,
                            });
                          } catch {
                            // Cross-origin — can't read, keep current value
                          }
                        }
                        if (editingMode === "visual") injectVisualEditor();
                        if (editingMode === "blocks") injectCmsEditor();
                      }}
                    />
                  </div>
                )}
              </div>
            </ResizablePanel>
          </ResizablePanelGroup>
        )}
      </div>
      <CreatePageModal
        open={createPageDialogOpen}
        onOpenChange={setCreatePageDialogOpen}
        isPending={createPage.isPending}
        error={createPageError}
        templates={pages}
        onSubmit={handleCreatePage}
      />

      {siteSeoOpen && decofile && meta && (
        <Suspense fallback={null}>
          <SeoSheet
            open={siteSeoOpen}
            onOpenChange={setSiteSeoOpen}
            orgSlug={org.slug}
            virtualMcpId={virtualMcpId ?? ""}
            branch={branch ?? ""}
            decofile={decofile}
            meta={meta}
            onSaved={() => {
              setTimeout(() => {
                const iframe = previewIframeRef.current;
                if (!iframe) return;
                reloadIframeOrFallback(iframe, iframeSrcRef.current);
              }, DEV_SERVER_SETTLE_MS);
            }}
            target={{ kind: "site" }}
          />
        </Suspense>
      )}
    </div>
  );
}
