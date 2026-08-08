import { sleep } from "@decocms/shared/std";
import { useState, useRef, useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import { formatCodeTabId } from "@/layouts/main-panel-tabs/tab-id";
import { useChatTask } from "@/components/chat/context";
import { useProjectContext } from "@/sdk";
import { useSandboxLifecycle } from "@/components/sandbox/hooks/sandbox-lifecycle-context";
import { startCmsTour } from "@/components/cms-tour/cms-tour";
import { TOUR_ANCHORS } from "@/components/cms-tour/anchors";
import { useInsetContext } from "@/layouts/agent-shell-layout";
import { resolvePreviewDisplay } from "./preview-display";
import { useIframeLoadRecovery } from "./preview-iframe-recovery";
import { buildPreviewLabel } from "./preview-label";
import { sanitizeProductionUrl } from "@decocms/shared/deco-site-production-url";
import { useIsMobile } from "@decocms/ui/hooks/use-mobile.ts";
import { useT } from "@/i18n/use-t.ts";
import type { TranslationKey } from "@/i18n/use-t.ts";

import {
  ChevronDown,
  Code01,
  Compass01,
  Copy01,
  CursorClick01,
  DotsHorizontal,
  Globe02,
  LayoutAlt01,
  LinkExternal01,
  Loading01,
  Plus,
  PuzzlePiece01,
  SearchLg,
  CreditCardSearch,
  Monitor04,
  Phone02,
  RefreshCw01,
  Tablet01,
  Terminal,
} from "@untitledui/icons";
import { cn } from "@decocms/ui/lib/utils.ts";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { ToolbarIconButton } from "@/components/toolbar-icon-button";
import { HeaderTabButton } from "@/layouts/main-panel-tabs/header-tab-button";
import {
  MainPanelHeaderEndPortal,
  MainPanelHeaderPortal,
  useMainPanelHeaderSlot,
} from "@/layouts/agent-shell-layout/panel-header";
import { useTerminalVisibility } from "@/layouts/main-panel-tabs/terminal-visibility";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@decocms/ui/components/dropdown-menu.tsx";
import { useDecofile } from "@/components/sections-editor/use-decofile";
import { withVariantMatcherOverride } from "@/components/sections-editor/variant-matcher-override";
import { useLiveMeta } from "@/components/sections-editor/use-live-meta";
import {
  extractGlobalSections,
  extractPages,
  findPageForPath,
  hasEditableDecoContent,
  type GlobalSectionEntry,
  type PageEntry,
} from "@/components/sections-editor/page-list";
import {
  resolveBlocksTabState,
  toBlocksQueryState,
} from "@/layouts/main-panel-tabs/blocks-tab-state";
import {
  fillPathTemplate,
  normalizePagePath,
  splitPathTemplate,
  validatePagePath,
} from "@/components/sections-editor/page-path-utils";
import { decoBlockFileViewPath } from "@/components/sections-editor/deco-block-key";
import { findLivePageResolveType } from "@/components/sections-editor/section-catalog";
import {
  buildDraftPreviewUrl,
  buildGlobalSectionPreviewUrl,
} from "@/components/sections-editor/section-preview-url";
import { useCreatePage } from "@/components/sections-editor/use-create-page";
import { CreatePageModal } from "@/components/sections-editor/create-page-modal";
import { toast } from "sonner";
import { useIsDesktopApp } from "@/hooks/use-is-desktop-app";
import {
  openExternalUrlInSystemBrowser,
  registerPreviewOrigin,
} from "@/lib/desktop/tauri-bridge";
import {
  VISUAL_EDITOR_SCRIPT,
  VisualEditorPayloadSchema,
  type VisualEditorPayload,
} from "./visual-editor-script";
import { CMS_EDITOR_SCRIPT, CmsEditorPayloadSchema } from "./cms-editor-script";
import { parseSections } from "@/components/sections-editor/parse-sections";
import { resolveSectionCandidates } from "./section-candidates";
import { getPageVariantSectionsAt } from "@/components/sections-editor/page-variants";
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
import { manifestLoaderResolveTypes } from "@/components/sandbox/content/runnable-catalog";
import { track } from "@/lib/posthog-client";
import { useSandboxRepoDir } from "../hooks/use-sandbox-repo-dir";
import { useBlocksPreviewWorkspace } from "@/components/sandbox/blocks/blocks-preview-workspace-context";
import { BlocksPanel } from "@/components/sandbox/blocks/blocks-panel";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  type PanelImperativeHandle,
} from "@/components/resizable";
import {
  shouldAutoOpenCms,
  togglePreviewEditorMode,
  type PreviewEditingMode,
  type PreviewEditorMode,
} from "./editing-mode";

const VSCODE_ICON_URL =
  "https://decoims.com/decocms/01b321bd-4613-4b2c-9348-35058444d210/Visual_Studio_Code_1.35_icon.svg.png";
const CURSOR_ICON_URL =
  "https://decoims.com/decocms/7583d3b5-81d0-4afb-becf-6a59bbb3a68e/cursor-logo-icon-freelogovectors.net_.png";

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
 * Renders nothing; fires `onOpen` exactly once when mounted to auto-open the
 * CMS. Headless run-once helper mirroring `PathParamAutoFill`: the parent
 * mounts it only while the auto-open should happen (see `shouldAutoOpenCms`)
 * and latches on `onOpen`, so it unmounts the instant it fires and never
 * re-opens behind a user who has taken manual control. `queueMicrotask` defers
 * the imperative open to post-commit (panel mounted) instead of mid-render.
 */
function CmsAutoOpen({ onOpen }: { onOpen: () => void }) {
  const [fired, setFired] = useState(false);
  if (!fired) {
    setFired(true);
    queueMicrotask(onOpen);
  }
  return null;
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
  const isDesktopApp = useIsDesktopApp();
  const isMobile = useIsMobile();
  // Desktop: the main panel header hosts the preview controls (single top bar).
  // Mobile / standalone (no header slot): render the toolbar inline below.
  const headerSlot = useMainPanelHeaderSlot();
  const navigate = useNavigate();
  const { currentBranch: branch } = useChatTask();
  const workspace = useBlocksPreviewWorkspace();
  // Toggles the bottom terminal drawer (null on surfaces without the provider).
  const terminal = useTerminalVisibility();

  const goToTab = (main: string) => {
    navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({ ...prev, main }),
      replace: true,
    });
  };

  // Editing mode is singular: Visual editor and Blocks cannot be active
  // together. Device size is independent and survives mode switches.
  // Starts in plain "preview"; the CMS (blocks) auto-opens once its metadata is
  // ready to render content (see `blocksAutoOpenResolved` below), so users never
  // see the "Blocos indisponíveis"/loading card pop open on its own.
  const [editingMode, setEditingMode] = useState<PreviewEditingMode>("preview");
  // Latches once the CMS has auto-opened (or the user has taken manual control
  // of the editing mode), so the one-shot auto-open never fights the user.
  const [blocksAutoOpenResolved, setBlocksAutoOpenResolved] = useState(false);
  const [previewDeviceSize, setPreviewDeviceSize] =
    useState<PreviewDeviceSize>("desktop");
  const [visualElement, setVisualElement] =
    useState<VisualEditorPayload | null>(null);
  /** Section index selected via click-through from the preview iframe. */
  const [cmsSelectedSectionIndex, setCmsSelectedSectionIndex] = useState<
    number | null
  >(null);
  const previewIframeRef = useRef<HTMLIFrameElement>(null);
  const blocksPanelRef = useRef<PanelImperativeHandle>(null);
  /** Origin most recently confirmed registered with the native shell via
   *  `registerPreviewOrigin` — see the effect below that sets it. `null`
   *  until the very first desktop-app production-mode registration lands. */
  const [registeredPreviewOrigin, setRegisteredPreviewOrigin] = useState<
    string | null
  >(null);

  // Pages dropdown in URL bar
  const [pagesOpen, setPagesOpen] = useState(false);
  const [pagesSearch, setPagesSearch] = useState("");
  const pagesContainerRef = useRef<HTMLDivElement>(null);
  const [createPageDialogOpen, setCreatePageDialogOpen] = useState(false);
  const [createPageError, setCreatePageError] = useState<string | undefined>();
  // Bumped after a Blocks save so the Fast Preview daemon frame re-navigates and
  // the daemon re-reads the fresh `.deco/blocks/*` (the "save → refresh" step).
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

  const { org } = useProjectContext();

  const vmEvents = useSandboxEvents();
  const lifecycle = useSandboxLifecycle();
  const vmEntry = lifecycle.vmEntry;
  const previewUrl = lifecycle.previewUrl;
  const lifecyclePhase = vmEvents.lifecycle.phase;
  const decofileVersion = vmEvents.decofileVersion;
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
  const decofileQuery = useDecofile(decofileParams, {
    fetchEnabled: devServerReady,
  });
  const metaQuery = useLiveMeta(decofileParams, {
    fetchEnabled: devServerReady,
  });
  const decofile = decofileQuery.data;
  const meta = metaQuery.data;
  // Same readiness classification the CMS panel itself uses. We only auto-open
  // the CMS once this resolves to "content" (metadata loaded AND there is
  // editable content) so the panel never opens onto a loading/empty/error card.
  const blocksReady =
    resolveBlocksTabState({
      lifecyclePhase,
      decofile: toBlocksQueryState(decofileQuery),
      meta: toBlocksQueryState(metaQuery),
      hasEditableContent: hasEditableDecoContent(decofile, meta),
    }).kind === "content";
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

  // Live production URL of the linked site, persisted on the agent's
  // `metadata.productionUrl` at import time (deco.cx reports the real domain,
  // which can be a custom one — so we store it rather than guess it). Used as a
  // published-site fallback while the sandbox provisions (non-blocking) instead
  // of a blank overlay; once the daemon is up, Fast Preview swaps to the daemon
  // render (`draftPreviewUrl` below). `null` (no field, or a site imported
  // before this was persisted) → the original blocking overlay is kept.
  const inset = useInsetContext();
  const productionUrl =
    inset?.entity?.id === virtualMcpId
      ? sanitizeProductionUrl(inset.entity.metadata?.productionUrl)
      : null;
  // Per-agent "Open CMS" Layout setting, read off the entity already in
  // context (same source as productionUrl above). Off by default (absent /
  // null → false): Preview stays on the site until the user opens the CMS
  // manually, unless an agent opts in to auto-open.
  const cmsDefaultOpen =
    (inset?.entity?.id === virtualMcpId
      ? inset.entity.metadata?.ui?.layout?.cmsDefaultOpen
      : null) ?? false;

  // Fast Preview (opt-in switch in CMS settings): render the draft against
  // `productionUrl` instead of the published site while the sandbox boots.
  // Requires BOTH the switch and a production URL — a bare flag is inert
  // (nothing to render against), and `productionUrl` is non-null only for this
  // agent's entity, so reading `metadata.fastPreview` off the same object is
  // safe.
  const fastPreviewEnabled =
    !!productionUrl && inset?.entity?.metadata?.fastPreview === true;

  // Fast Preview (gated by the CMS switch): render the site's REAL page on
  // `productionUrl`, carrying a `?__draft=<handle>@<version>` pointer that the
  // site's framework resolves by pulling the merged working-tree decofile from
  // the sandbox daemon. Replaces POSTing the decofile at `/live/previews`,
  // which only deco's own runtime honoured and could only render one component
  // statically.
  //
  // Needs the daemon origin and a draft version — NOT the dev server, and
  // notably not `currentPageKey` any more: the site does its own routing, so
  // the preview no longer waits on the decofile query that used to stall the
  // whole surface behind a cold-start 502.
  //
  // `version` changes on every `.deco/blocks/*` save (the daemon's `decofile`
  // event), which re-navigates the frame — no cache-busting nonce needed.
  //
  // Computed BEFORE `display`: it is an input to that decision, so it must not
  // depend on `display.mode` in turn.
  const draftPreviewUrl =
    fastPreviewEnabled && productionUrl && previewUrl && decofileVersion
      ? buildDraftPreviewUrl({
          productionUrl,
          previewUrl,
          version: decofileVersion,
          path: resolvedPath,
        })
      : null;

  // The recorded previewUrl flips previewState to "iframe" as soon as the
  // sandbox handle exists — well before the public preview proxy is routable —
  // so the sandbox surface is gated on `progress.status` (boot no longer in
  // progress), not on `previewUrl` alone. `resolvePreviewDisplay` decides what
  // to paint: the sandbox iframe, the published site + a waking pill, or
  // (no production URL) the blocking booting overlay.
  const display = resolvePreviewDisplay({
    previewState,
    progressStatus: progress.status,
    productionUrl,
    fastPreviewActive: fastPreviewEnabled,
    fastPreviewReady: !!draftPreviewUrl,
  });
  const previewSurfaceActive = display.mode !== "none";

  // Origin of the "production" mode's base — an external, org-owned domain
  // (the published site), unlike "sandbox" mode's `iframeBase`, which is
  // always this app's own local sandbox-preview-proxy origin (already
  // allowed natively, no registration needed). `null` outside production
  // mode, or once no `iframeBase` is available yet.
  const productionOrigin =
    display.mode === "production" && display.iframeBase
      ? new URL(display.iframeBase).origin
      : null;
  // In the desktop app, an external production origin must be registered
  // with the native shell's navigation policy BEFORE the iframe below is
  // allowed to navigate there — see `registerPreviewOrigin`'s doc comment
  // for why this can't be fire-and-forget. Plain browser tabs have no such
  // gate, so this is a no-op there.
  const productionOriginReady =
    !isDesktopApp ||
    !productionOrigin ||
    registeredPreviewOrigin === productionOrigin;

  const iframeSrc =
    display.mode === "sandbox"
      ? withVariantMatcherOverride(
          withDeviceHint(
            directPreviewUrl ?? new URL(resolvedPath, display.iframeBase!).href,
            previewDeviceSize,
          ),
          workspace.state.variantOverride ?? [],
        )
      : display.mode === "production" && productionOriginReady
        ? // The published site is the base for both modes while the sandbox
          // provisions; Fast Preview swaps in the same page carrying a
          // `?__draft=` pointer the moment one exists. Same origin either way,
          // so the swap changes content, not surface.
          withDeviceHint(
            draftPreviewUrl ?? new URL(resolvedPath, display.iframeBase!).href,
            previewDeviceSize,
          )
        : null;

  // Registers `productionOrigin` with the native shell before the iframe
  // above is allowed to navigate there (see `productionOriginReady`).
  // oxlint-disable-next-line ban-use-effect/ban-use-effect -- imperative native-shell IPC gate before cross-origin iframe navigation, mirrors the draft-URL effect just below
  useEffect(() => {
    if (!isDesktopApp || !productionOrigin) return;
    if (registeredPreviewOrigin === productionOrigin) return;
    let cancelled = false;
    registerPreviewOrigin(productionOrigin)
      .then(() => {
        if (!cancelled) setRegisteredPreviewOrigin(productionOrigin);
      })
      .catch((error) => {
        console.error(
          "Failed to register preview origin",
          productionOrigin,
          error,
        );
      });
    return () => {
      cancelled = true;
    };
  }, [isDesktopApp, productionOrigin, registeredPreviewOrigin]);

  // "Open outside the preview pane". In a browser that's a new tab; inside the
  // Tauri webview there is no tab strip to open into, so `window.open` cannot
  // serve it — hand the URL to the OS default browser instead, and say so.
  const openPreviewLabelKey = isDesktopApp
    ? ("sandbox.preview.openInBrowser" as const)
    : ("sandbox.preview.openInNewTab" as const);

  /**
   * URL for "open in new tab" — the same page, minus Studio's viewport hint.
   *
   * `deviceHint` exists to make the embedded frame mimic the selected device;
   * it has no business in a link someone pastes to a colleague. Under Fast
   * Preview this is the draft URL itself, which is shareable precisely because
   * the pointer is a query param on the site's own route.
   */
  const openInNewTabUrl =
    display.mode === "production"
      ? (draftPreviewUrl ??
        (display.iframeBase
          ? new URL(resolvedPath, display.iframeBase).href
          : null))
      : (iframeSrc ?? display.iframeBase);

  const handleOpenPreview = async () => {
    const url = openInNewTabUrl;
    if (!url) return;
    if (!isDesktopApp) {
      window.open(url, "_blank", "noopener");
      return;
    }
    try {
      await openExternalUrlInSystemBrowser(url);
    } catch {
      toast.error(t("sandbox.preview.failedToOpenInBrowser"));
    }
  };

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

  // Self-heal a stuck iframe: when the dev server is/was unreachable the frame
  // lands on the browser's connection-refused page and fires no load/error
  // event, so nothing reloads it once the server is back. This watchdog retries
  // (backoff) until a load fires. Sandbox surface only — never thrash the
  // best-effort production fallback frame, nor the Fast Preview daemon frame,
  // which has its own cross-origin navigation path below.
  const iframeRecovery = useIframeLoadRecovery({
    iframeRef: previewIframeRef,
    src: display.mode === "sandbox" ? iframeSrc : null,
    active: display.mode === "sandbox",
  });

  // Fast Preview refresh backstop: the daemon frame is cross-origin (the daemon
  // host), so the shared reload path can't `.reload()` it. When the draft URL
  // changes — a page switch, or a new version after a save — force-navigate the
  // frame. The version makes the URL distinct, and the ref guard makes the
  // first paint (React already set `src`) and unrelated re-renders no-ops.
  const lastDraftUrlRef = useRef<string | null>(null);
  // oxlint-disable-next-line ban-use-effect/ban-use-effect -- imperative cross-origin iframe navigation on draft change; .reload() throws cross-origin
  useEffect(() => {
    if (!draftPreviewUrl || !iframeSrc) return;
    if (lastDraftUrlRef.current === draftPreviewUrl) return;
    lastDraftUrlRef.current = draftPreviewUrl;
    const iframe = previewIframeRef.current;
    if (iframe && iframe.getAttribute("src") !== iframeSrc) {
      beginNavigation();
      iframe.src = iframeSrc;
    }
  }, [draftPreviewUrl, iframeSrc]);

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

  // Visual mode requires the live sandbox iframe — the production fallback is a
  // different origin we can't inject into. Blocks can stay open while the
  // sandbox restarts (or wakes) so its loading/error state remains actionable
  // and the panel keeps reading the committed snapshot.
  const effectiveEditingMode: PreviewEditingMode =
    display.mode !== "sandbox" && editingMode === "visual"
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
      if (mode === "blocks") blocksPanelRef.current?.resize("30%");
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
    // The user is driving the editing mode now — stop the one-shot CMS
    // auto-open from ever kicking in behind them. This is the ONLY path back to
    // `editingMode === "preview"` (the direct `activateEditingMode("blocks")`
    // calls only ever leave it in "blocks"), so latching here is what keeps
    // auto-open from re-firing after a manual close.
    setBlocksAutoOpenResolved(true);
    activateEditingMode(togglePreviewEditorMode(editingMode, mode));
  };

  // One-shot: auto-open the CMS the first time Blocks metadata is ready to
  // render content, so the panel never pops open onto a loading/empty/error
  // card. Gated by the per-agent "Open CMS" Layout setting. Handled by the
  // headless `<CmsAutoOpen>` below, mounted only while `shouldAutoOpenCms`
  // holds; `onOpen` latches so it fires exactly once.
  const autoOpenCms = shouldAutoOpenCms({
    cmsDefaultOpen,
    blocksReady,
    autoOpenResolved: blocksAutoOpenResolved,
    editingMode,
  });
  const handleCmsAutoOpen = () => {
    setBlocksAutoOpenResolved(true);
    activateEditingMode("blocks");
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
  // decofile edits, which the framework's HMR doesn't cover. In Fast Preview
  // the refresh is already driven by the draft VERSION: the same write emits a
  // `decofile` event, the new version changes `draftPreviewUrl`, and the effect
  // above re-navigates the frame. Reloading here as well would race that with a
  // stale URL, so this path yields; the sandbox path uses the normal reload.
  useSandboxReloadHandler(() => {
    if (draftPreviewUrl) return;
    reloadPreviewPreservingScroll();
  });
  // Show the loading overlay the instant a `.deco/` change is detected, ahead of
  // the debounced reload above, so the pending refresh feels immediate.
  useSandboxReloadStartHandler(() => {
    beginNavigation();
  });

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

  // Domain shown in the URL bar follows what's actually in the iframe
  // (`display.iframeBase`) — production under Fast Preview, the sandbox
  // otherwise — so the label never drifts from the rendered page.
  const previewLabel = buildPreviewLabel({
    iframeBase: display.iframeBase,
    resolvedPath,
    activeGlobalSectionName: activeGlobalSection?.name ?? null,
    noServerLabel: t("sandbox.preview.noServerRunning"),
  });

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

  // Toolbar visibility follows main's display model: shown once an iframe
  // surface is active — the sandbox once its daemon is up, or the production
  // fallback while the dev server is still waking (see resolvePreviewDisplay).
  const showPreviewToolbar =
    previewSurfaceActive && (daemonReady || display.mode === "production");

  // Blocks is an editing mode on the current page, NOT a navigation view — and
  // its editor opens on the LEFT. So its toggle lives in the floating preview
  // pill next to the visual-editor / device controls (see below), grouped with
  // the other edit-mode affordances rather than in the header's nav-tab row.
  const blocksActive = editingMode === "blocks";

  // Refresh + page selector + open-in-new-tab — the URL group. Sized to content
  // (capped) rather than stretching, so it doesn't dominate the top bar.
  // Edit (Blocks) — the primary "edit this page" action, tied to the page the
  // selector shows. On desktop it leads the URL group, set off by a divider, so
  // it reads as a distinct action rather than being wedged inside the URL
  // controls. On mobile it anchors the left edge on its own (see below).
  // Filled when the Blocks editor is open; click again for plain preview.
  const cmsToggle = showPreviewToolbar ? (
    <HeaderTabButton
      title={t("sandbox.preview.cms")}
      tooltip={
        blocksActive
          ? t("sandbox.preview.exitEditor")
          : t("sandbox.preview.editContent")
      }
      // Distinctive icon — sheds its label with the system tabs at 768px,
      // well before this group hides at 384px, so the group stays narrow
      // through the widths where it is most cramped.
      labelCollapse="sooner"
      icon={{ kind: "component", Component: PuzzlePiece01 }}
      active={blocksActive}
      onClick={() => toggleEditingMode("blocks")}
      testId="preview-blocks-toggle"
      dataTour={TOUR_ANCHORS.edit}
    />
  ) : null;

  // The view controls proper: refresh · page selector · open-in-new. Kept as a
  // unit so both layouts can place it as one block — inline after the Edit
  // action on desktop, or in its own centered slot on mobile.
  const urlGroup = showPreviewToolbar ? (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <ToolbarIconButton
            onClick={handleRefresh}
            aria-label={t("sandbox.preview.refresh")}
          >
            <RefreshCw01 size={16} />
          </ToolbarIconButton>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {t("sandbox.preview.refresh")}
        </TooltipContent>
      </Tooltip>

      <div ref={pagesContainerRef} className="relative min-w-0 w-64 shrink">
        <div className="flex h-7 w-full min-w-0 items-center rounded-md border border-border bg-background transition-colors duration-200 hover:bg-accent">
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
                // A real page name keeps priority — the route path (flex-1,
                // below) is the first to truncate. But the name still carries
                // `min-w-0 truncate` so, once the path is fully shed, the name
                // clips with an ellipsis instead of sliding under the chevron.
                currentPageName == null
                  ? "min-w-0 flex-1 truncate"
                  : "min-w-0 shrink truncate",
              )}
            >
              {currentPageName ?? previewLabel}
            </span>
            {!activeGlobalSection && currentPageName != null && currentPath && (
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
                      onCommit={(value) => setPathParamValue(token.name, value)}
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
          <div className="absolute left-1/2 top-full z-50 mt-1.5 w-[500px] max-w-[calc(100vw-2rem)] -translate-x-1/2 overflow-hidden rounded-lg border bg-popover shadow-lg">
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
                placeholder={t("sandbox.preview.searchPagesAndComponents")}
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
                <Plus size={16} className="shrink-0 text-muted-foreground" />
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
      {/* Available on every surface. Under Fast Preview `iframeSrc` is the
          site's own page URL carrying `?__draft=<handle>@<version>`, so the
          opened tab renders the same draft — an ordinary, shareable link. That
          was not true of the old `/live/previews` render, which is why this
          button used to be sandbox-only. */}
      <Tooltip>
        <TooltipTrigger asChild>
          <ToolbarIconButton
            aria-label={t(openPreviewLabelKey)}
            onClick={() => void handleOpenPreview()}
          >
            <LinkExternal01 size={16} />
          </ToolbarIconButton>
        </TooltipTrigger>
        <TooltipContent side="bottom">{t(openPreviewLabelKey)}</TooltipContent>
      </Tooltip>
    </>
  ) : null;

  // Desktop composition (portaled into the panel header's centre slot): the
  // Edit action leads, set off by a divider, then the view controls.
  const urlControls = showPreviewToolbar ? (
    <div className="flex min-w-0 items-center gap-0.5">
      {cmsToggle}
      <div className="mx-0.5 h-5 w-px shrink-0 bg-border" />
      {urlGroup}
    </div>
  ) : null;

  // Overflow menu (⋯) — sits on the right, beside the publish actions. Renders
  // whenever there's at least one available action: the Terminal toggle is
  // always available (so it stays reachable during boot, before the iframe is
  // up), while copy / SEO items are gated on the preview being live.
  const moreMenu =
    showPreviewToolbar || terminal ? (
      <div className="flex shrink-0 items-center">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("sandbox.preview.moreOptions")}
            >
              <DotsHorizontal size={14} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            {terminal && (
              <DropdownMenuItem
                onClick={() => terminal.setVisible(!terminal.visible)}
              >
                <Terminal size={14} />
                {terminal.visible
                  ? t("sandbox.preview.hideTerminal")
                  : t("sandbox.preview.showTerminal")}
              </DropdownMenuItem>
            )}
            {showPreviewToolbar && (
              <>
                {terminal && <DropdownMenuSeparator />}
                <DropdownMenuItem onClick={handleCopyUrl}>
                  <Copy01 size={14} />
                  {t("sandbox.preview.copyCurrentUrl")}
                </DropdownMenuItem>
              </>
            )}
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
                        toast.error(t("sandbox.preview.invalidPageBlockKey"));
                      }
                    }}
                  >
                    <Code01 size={14} />
                    {t("sandbox.preview.viewJson")}
                  </DropdownMenuItem>
                )}
              </>
            )}
            {repoDir && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => window.open(ideDeepLink("vscode", repoDir))}
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
                  onClick={() => window.open(ideDeepLink("cursor", repoDir))}
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
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => startCmsTour(t)}>
              <Compass01 size={14} />
              {t("cmsTour.menuItem")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    ) : null;

  const canVisualEdit = display.mode === "sandbox";
  const floatingPreviewControls = canVisualEdit ? (
    <div className="absolute bottom-4 left-1/2 z-20 -translate-x-1/2 scale-125">
      <div className="flex items-center gap-0.5 rounded-full border bg-background/60 p-1 shadow-lg backdrop-blur-md">
        <Tooltip>
          <TooltipTrigger asChild>
            <ToolbarIconButton
              onClick={() => toggleEditingMode("visual")}
              aria-pressed={editingMode === "visual"}
              aria-label={t("sandbox.preview.visualEditor")}
              active={editingMode === "visual"}
              disabled={!canVisualEdit}
              className="rounded-full"
              data-tour={TOUR_ANCHORS.visualEditor}
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
              className="rounded-full"
              data-tour={TOUR_ANCHORS.device}
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
      {/* Headless: auto-opens the CMS once (renders nothing). Mounted only
          while the per-agent setting + readiness say it should. */}
      {autoOpenCms && <CmsAutoOpen onOpen={handleCmsAutoOpen} />}
      {/* Auto-select the first entity for a picker param with no value yet, so
          navigating to a bare dynamic-route template lands on a real page.
          Each helper renders nothing and unmounts once its param is filled. */}
      {pickerSandboxRef &&
        Object.entries(pathParamSources).map(([name, sources]) =>
          (pathParamValues[name] ?? "") === "" ? (
            <PathParamAutoFill
              key={`${currentPageKey}:${name}`}
              sources={sources}
              template={currentPath}
              paramName={name}
              sandboxRef={pickerSandboxRef}
              onFill={(value) => setPathParamValue(name, value)}
            />
          ) : null,
        )}
      {headerSlot ? (
        <>
          {showPreviewToolbar && (
            <MainPanelHeaderPortal>{urlControls}</MainPanelHeaderPortal>
          )}
          {/* End slot renders even during boot (showPreviewToolbar false): the
              ⋯ menu is present so its Terminal toggle stays reachable, and the
              preview-only items join once the iframe is live. */}
          <MainPanelHeaderEndPortal>{moreMenu}</MainPanelHeaderEndPortal>
        </>
      ) : (
        (showPreviewToolbar || moreMenu) && (
          // Declares the same container as PanelHeader: on this path (no header
          // slot — mobile) the controls render inline instead of portaling, so
          // without it their container queries would find no container and every
          // label would stay at full width.
          //
          // Three zones rather than the desktop's single left-packed group: Edit
          // anchors the left edge, the view controls sit in the middle, and the
          // ⋯ menu holds the right. Packed left, the page selector sat wherever
          // Edit and refresh pushed it — visibly off-centre on a phone, where
          // the bar is the whole screen.
          //
          // The two side zones are `flex-1` (equal basis) and the middle is
          // content-sized, so the selector centres on the BAR wherever there is
          // slack to divide. Giving the middle the flex-1 instead centres it
          // between the side zones, which are unequal — Edit is ~9px wider than
          // ⋯ — leaving it visibly off. On the narrowest phones the zones can no
          // longer be equal either (the left one cannot shrink below the Edit
          // button), so ~5px of that asymmetry returns; closing it completely
          // would mean pinning both sides to a fixed width and letting the
          // selector lose the space instead.
          <div className="@container/panel-header relative flex h-12 shrink-0 items-center gap-2 border-b border-border/60 px-3 md:px-4">
            <div className="flex flex-1 items-center justify-start">
              {cmsToggle}
            </div>
            <div className="flex min-w-0 shrink items-center justify-center gap-0.5">
              {urlGroup}
            </div>
            <div className="flex flex-1 items-center justify-end">
              {moreMenu}
            </div>
          </div>
        )
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
          <ResizablePanelGroup
            orientation="horizontal"
            disabled={effectiveEditingMode !== "blocks"}
          >
            <ResizablePanel
              ref={blocksPanelRef}
              id="preview-blocks-editor"
              defaultSize={effectiveEditingMode === "blocks" ? "30%" : "0%"}
              minSize="20%"
              collapsible
              collapsedSize="0%"
              className="min-w-0 overflow-hidden"
            >
              {effectiveEditingMode === "blocks" && (
                <BlocksPanel
                  virtualMcpId={virtualMcpId}
                  externalSelectedIndex={cmsSelectedSectionIndex}
                />
              )}
            </ResizablePanel>
            {effectiveEditingMode === "blocks" && (
              <ResizableHandle withHandle />
            )}
            <ResizablePanel
              id="preview-canvas"
              defaultSize={effectiveEditingMode === "blocks" ? "70%" : "100%"}
              minSize="35%"
              className="min-w-0 overflow-hidden"
            >
              <div
                className={cn(
                  "h-full relative overflow-hidden",
                  previewDeviceSize !== "desktop" &&
                    previewSurfaceActive &&
                    "flex justify-center bg-muted/30",
                )}
              >
                {navigating && previewSurfaceActive && (
                  <div className="absolute inset-x-0 top-0 z-40 h-0.5 overflow-hidden bg-primary/15">
                    <div className="absolute inset-y-0 w-2/5 rounded-full bg-primary animate-preview-nav" />
                  </div>
                )}

                {display.showBlockingOverlay && (
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

                {display.showWakingPill && (
                  <div className="absolute top-4 left-1/2 z-20 flex max-w-md -translate-x-1/2 items-start gap-3 rounded-xl border border-border bg-muted px-4 py-3 shadow-lg pointer-events-none select-none">
                    <Loading01
                      size={18}
                      className="mt-0.5 shrink-0 animate-spin text-muted-foreground"
                    />
                    <div className="flex flex-col gap-0.5">
                      <span className="text-sm font-medium text-foreground">
                        {t("sandbox.preview.startingPreview")}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {t("sandbox.preview.startingPreviewHint")}
                      </span>
                    </div>
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

                {previewSurfaceActive && iframeSrc && (
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
                      // Key on the iframe base: remount when the base URL changes
                      // (branch switch, or the production→sandbox swap once the dev
                      // server is up). Path navigation is driven by `iframeSrc`.
                      key={display.iframeBase}
                      ref={previewIframeRef}
                      src={iframeSrc}
                      className="w-full h-full border-0"
                      title={t("sandbox.preview.devServerPreviewTitle")}
                      onError={iframeRecovery.handleError}
                      onLoad={() => {
                        // A load reached the frame — cancel the recovery watchdog
                        // and reset its backoff before anything else.
                        iframeRecovery.handleLoad();
                        // The page finished loading — always clear the navigation
                        // indicator first, before any of the early returns below.
                        endNavigation();
                        // The production fallback is a view-only, cross-origin frame:
                        // skip the sandbox-only load handling (analytics, path sync,
                        // editor injection) — none of it applies to it.
                        if (display.mode !== "sandbox") return;
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
    </div>
  );
}
