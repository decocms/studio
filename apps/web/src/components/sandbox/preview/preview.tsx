import { useState, useRef, useEffect, type CSSProperties } from "react";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import { useChatTask } from "@/components/chat/context";
import { useProjectContext } from "@/sdk";
import { useSandboxLifecycle } from "@/components/sandbox/hooks/sandbox-lifecycle-context";
import { useInsetContext } from "@/layouts/agent-shell-layout";
import { resolvePreviewDisplay } from "./preview-display";
import { useIframeLoadRecovery } from "./preview-iframe-recovery";
import { resolvePreviewServerUrl } from "@decocms/shared/deco-site-production-url";
import { useSessionRuntime } from "@/hooks/use-session-runtime";
import { resolveCmsMode } from "@decocms/shared/sdk/types";
import { useIsMobile } from "@decocms/ui/hooks/use-mobile.ts";
import { useT } from "@/i18n/use-t.ts";
import type { TranslationKey } from "@/i18n/use-t.ts";

import {
  CursorClick01,
  LinkExternal01,
  ChevronDown,
  Database01,
  Globe02,
  LayoutAlt01,
  Plus,
  Monitor04,
  SearchLg,
  Phone02,
  RefreshCw01,
  Tablet01,
} from "@untitledui/icons";
import { cn } from "@decocms/ui/lib/utils.ts";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { ToolbarIconButton } from "@/components/toolbar-icon-button";
import {
  MainPanelHeaderPortal,
  useMainPanelHeaderSlot,
} from "@/layouts/agent-shell-layout/panel-header";
import { useDecofile } from "@/components/sections-editor/use-decofile";
import { withVariantMatcherOverride } from "@/components/sections-editor/variant-matcher-override";
import { useLiveMeta } from "@/components/sections-editor/use-live-meta";
import {
  extractGlobalSections,
  extractPages,
  findPageForPath,
  type GlobalSectionEntry,
  type PageEntry,
} from "@/components/sections-editor/page-list";
import {
  fillPathTemplate,
  normalizePagePath,
  splitPathTemplate,
  validatePagePath,
} from "@/components/sections-editor/page-path-utils";
import { findLivePageResolveType } from "@/components/sections-editor/section-catalog";
import {
  buildGlobalSectionPreviewUrl,
  buildPageRenderRequest,
  DRAFT_OFF,
  resolveSectionPreviewBase,
  withDraftPointer,
} from "@/components/sections-editor/section-preview-url";
import { useFastPreviewDraftUrl } from "@/components/sections-editor/use-fast-preview-draft-url";
import { useDecofileWriting } from "@/components/sections-editor/use-decofile-writing";
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
} from "../hooks/use-sandbox-events";
import { SandboxStateCard } from "./state-card";
import {
  lastPreviewPageKey,
  readLastPreviewPage,
  writeLastPreviewPage,
  type LastPreviewPage,
} from "./last-preview-page";
import { derivePhaseProgress } from "./derive-phase-progress";
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
import { buildPreviewLabel } from "./preview-label";
import { showCmsPageSelector } from "./cms-controls";
import { useCreatePage } from "@/components/sections-editor/use-create-page";
import { CreatePageModal } from "@/components/sections-editor/create-page-modal";
import { sleep } from "@decocms/shared/std";
import {
  listSavedRunnables,
  manifestLoaderResolveTypes,
  type SavedRunnableEntry,
} from "@/components/sandbox/content/runnable-catalog";
import { track } from "@/lib/posthog-client";
import { useBlocksPreviewWorkspace } from "@/components/sandbox/blocks/blocks-preview-workspace-context";
import { BlocksPanel } from "@/components/sandbox/blocks/blocks-panel";
import {
  PageJsonPanel,
  type PageJsonPanelHandle,
} from "@/components/sandbox/blocks/page-json-panel";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  type PanelImperativeHandle,
} from "@/components/resizable";
import {
  defaultPreviewEditingMode,
  isBlocksEditingEnabled,
  resolveEffectivePreviewEditingMode,
  toggleVisualEditingMode,
  type PreviewEditingMode,
} from "./editing-mode";
import { isContentEditingEnabled } from "@/layouts/main-panel-tabs/content-editing-gate";

/** Delay before navigating to a newly created page, giving the dev server time to route it. */
const DEV_SERVER_SETTLE_MS = 500;

type PreviewDeviceSize = "mobile" | "tablet" | "desktop";

/**
 * Logical viewport dimensions per device, matching the legacy admin. The iframe
 * always renders the page at this fixed logical size and is then scaled down
 * with a CSS transform to fit the available canvas width — so widening the
 * blocks panel shrinks a faithful proportional miniature of the full layout
 * instead of reflowing the responsive breakpoints (desktop) or clipping the
 * frame (mobile/tablet).
 */
const PREVIEW_VIEWPORTS: Record<
  PreviewDeviceSize,
  { width: number; height: number }
> = {
  mobile: { width: 412, height: 823 }, // Moto G Power
  tablet: { width: 1024, height: 1366 }, // iPad Pro
  desktop: { width: 1280, height: 800 }, // MacBook Pro 14
};

/** Px inset so the scaled frame's border doesn't sit flush against the canvas edge. */
const PREVIEW_OFFSET = 1;

const DEVICE_CYCLE: PreviewDeviceSize[] = ["desktop", "mobile", "tablet"];

// Device labels are resolved per-render in the component to use t()
const DEVICE_LABEL_KEYS: Record<PreviewDeviceSize, TranslationKey> = {
  mobile: "sandbox.preview.deviceMobile",
  tablet: "sandbox.preview.deviceTablet",
  desktop: "sandbox.preview.deviceDesktop",
};

/**
 * Deco reads `deviceHint` to force SSR device matchers (see deco `deviceOf`).
 * Falls back to the unmodified `url` on a malformed input instead of throwing
 * mid-render and taking down the whole preview panel (same defensive shape as
 * `previewOrigin` below).
 */
export function withDeviceHint(url: string, device: PreviewDeviceSize): string {
  try {
    const parsed = new URL(url, window.location.href);
    parsed.searchParams.set("deviceHint", device);
    return parsed.href;
  } catch {
    return url;
  }
}

/**
 * Force `__decoFBT=0` and `__deco_ssr=1` on the preview URL — `__decoFBT=0`
 * disables deco's loader/block-tree cache so edits render immediately in the
 * iframe (same param the "Open result in new tab" invoke path sets, see
 * `buildInvokeRunUrl`); `__deco_ssr=1` forces server-side rendering for the
 * iframe. Passes `null` through so it can wrap the whole `iframeSrc`
 * computation regardless of mode, and falls back to the unmodified `url` on a
 * malformed input instead of throwing.
 */
export function withDecoFBT(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url, window.location.href);
    parsed.searchParams.set("__decoFBT", "0");
    parsed.searchParams.set("__deco_ssr", "1");
    return parsed.href;
  } catch {
    return url;
  }
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
 * Resolves `path` against `base` (both come from the sandbox daemon /
 * production preview server, so treat as untrusted), or `null` on a
 * malformed value instead of throwing mid-render — same defensive shape as
 * `previewOrigin` above.
 */
export function resolvePreviewUrl(path: string, base: string): string | null {
  try {
    return new URL(path, base).href;
  } catch {
    return null;
  }
}

/**
 * Relevance score for a page-picker hit against a lowercased query `q`.
 * Higher is better; `0` means no match. Ranks closer/more-specific matches
 * first so `/masculino` beats `/joias/colares/masculino` for the query
 * "masculino", instead of falling back to alphabetical order by title.
 */
function pageMatchScore(name: string, path: string, q: string): number {
  const n = name.toLowerCase();
  const p = path.toLowerCase();
  const segments = p.split("/").filter(Boolean);
  const textScore = (text: string): number => {
    if (text === q) return 100;
    const idx = text.indexOf(q);
    if (idx === -1) return 0;
    let s = 40;
    if (idx === 0)
      s += 30; // starts with the query
    else if (/[\s/-]/.test(text[idx - 1] ?? "")) s += 20; // segment boundary
    s += Math.round((q.length / text.length) * 20); // query covers more = closer
    return s;
  };
  let score = Math.max(textScore(n), textScore(p));
  if (segments.at(-1) === q)
    score = Math.max(score, 95); // query is the path's leaf segment
  else if (segments.includes(q)) score = Math.max(score, 90); // whole segment
  return score;
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
  const { currentBranch: branch, taskId: activeTaskId } = useChatTask();
  const workspace = useBlocksPreviewWorkspace();
  const inset = useInsetContext();
  /** THIS session's runtime, off the thread's own immutable stamp — the one
   *  thread-aware gate, scoped to this agent's entity by the id match. */
  const session = useSessionRuntime(virtualMcpId);
  /** Settings › CMS for this project. `off` is the one thing that keeps a CMS
   *  session out of the blocks editor below. */
  const cmsMode = resolveCmsMode(
    inset?.entity?.id === virtualMcpId
      ? (inset.entity.metadata?.ui?.layout ?? null)
      : null,
  );
  const contentEditingEnabled = isContentEditingEnabled(cmsMode);
  const blocksEditingEnabled = isBlocksEditingEnabled({
    contentEditingEnabled,
    isMobile,
  });

  /** Singular: Visual and Blocks cannot both be active, while device size is
   *  independent and survives a switch. Blocks starts open whenever the shared
   *  Content gate and desktop constraint allow it. */
  const [editingMode, setEditingMode] = useState<PreviewEditingMode>(() =>
    defaultPreviewEditingMode({ cmsMode, isMobile }),
  );
  const [previewDeviceSize, setPreviewDeviceSize] =
    useState<PreviewDeviceSize>("desktop");
  const [visualElement, setVisualElement] =
    useState<VisualEditorPayload | null>(null);
  /**
   * Section selected via click-through from the preview iframe. Carries the
   * iframe's per-click counter so that re-clicking the SAME section is still a
   * new selection — without it, reopening a section the editor had navigated
   * away from looked like "no change" and silently did nothing.
   */
  const [cmsSelectedSection, setCmsSelectedSection] = useState<{
    index: number;
    seq: number;
  } | null>(null);
  const previewIframeRef = useRef<HTMLIFrameElement>(null);
  const blocksPanelRef = useRef<PanelImperativeHandle>(null);
  // Raw Page JSON side panel open state; the page it shows follows currentPageKey.
  const [jsonPanelOpen, setJsonPanelOpen] = useState(false);
  const jsonPanelHandleRef = useRef<PageJsonPanelHandle>(null);
  const closeJsonPanel = () => {
    jsonPanelHandleRef.current?.flush();
    setJsonPanelOpen(false);
  };
  const toggleJsonPanel = () =>
    setJsonPanelOpen((open) => {
      if (open) jsonPanelHandleRef.current?.flush();
      return !open;
    });
  // Live canvas size, used to scale the fixed-width frame to fit.
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
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
  const [activeGlobalSection, setActiveGlobalSection] =
    useState<GlobalSectionEntry | null>(null);
  /** Decofile key of the global loader open in the Blocks panel, if any. */
  const [activeLoaderKey, setActiveLoaderKey] = useState<string | null>(null);
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
  const devServerReady = lifecyclePhase === "running";

  // Live production URL of the linked site, persisted on the agent's
  // `metadata.previewServerUrl` at import time (deco.cx reports the real domain,
  // which can be a custom one — so we store it rather than guess it). Used as a
  // published-site fallback while the sandbox provisions (non-blocking) instead
  // of a blank overlay. `null` (no field, or a site imported before this was
  // persisted) → the original blocking overlay is kept.
  const previewServerUrl =
    inset?.entity?.id === virtualMcpId
      ? resolvePreviewServerUrl(inset.entity.metadata)
      : null;
  const fastPreviewEnabled =
    inset?.entity?.id === virtualMcpId && session.runtime === "cms";
  /** This project defaults to CMS — the question `fastPreviewEnabled` answers for the SESSION. */
  const projectDefaultsToCms = session.projectDefault === "cms";

  // Base for the `/live/previews` global-section render: production under Fast Preview (no dev server), else the sandbox dev server.
  const sectionPreviewBase = resolveSectionPreviewBase({
    sandboxUrl: previewUrl,
    previewServerUrl,
    fastPreviewActive: fastPreviewEnabled,
  });

  // Decofile pages/global sections for the URL bar dropdown. Not gated on the
  // dev server: when it's down we read the committed `.deco/*.gen.json` snapshot
  // so the dropdown still lists pages; the live routes take over once it's up.
  // (The inline CMS overlay still needs the dev server — it edits the page
  // rendered inside the iframe, which the dev server serves.)
  const decofileParams =
    virtualMcpId && branch
      ? {
          orgSlug: org.slug,
          virtualMcpId,
          branch,
          threadId: activeTaskId ?? null,
          previewUrl,
        }
      : null;
  const decofileQuery = useDecofile(decofileParams, {
    fetchEnabled: devServerReady,
  });
  const metaQuery = useLiveMeta(decofileParams, {
    fetchEnabled: devServerReady,
  });
  const decofile = decofileQuery.data;
  const meta = metaQuery.data;
  const pages = decofile
    ? extractPages(decofile).sort((a, b) => a.name.localeCompare(b.name))
    : [];
  const createPageParams =
    virtualMcpId && branch ? { orgSlug: org.slug, virtualMcpId, branch } : null;
  const createPage = useCreatePage(createPageParams);
  const globalSections =
    decofile && meta ? extractGlobalSections(decofile, meta) : [];
  const globalLoaders =
    decofile && meta ? listSavedRunnables(meta, decofile, "loaders") : [];
  const filteredPages = !pagesSearch
    ? pages
    : (() => {
        const q = pagesSearch.toLowerCase();
        // Stable sort keeps `pages`' alpha order as tie-break; shorter path wins.
        return pages
          .map((page) => ({
            page,
            score: pageMatchScore(page.name, page.path, q),
          }))
          .filter(({ score }) => score > 0)
          .sort(
            (a, b) =>
              b.score - a.score || a.page.path.length - b.page.path.length,
          )
          .map(({ page }) => page);
      })();
  const filteredGlobalSections = globalSections.filter((section) => {
    if (!pagesSearch) return true;
    const q = pagesSearch.toLowerCase();
    return (
      section.name.toLowerCase().includes(q) ||
      section.key.toLowerCase().includes(q) ||
      section.resolveType.toLowerCase().includes(q)
    );
  });
  const visibleGlobalLoaders = blocksEditingEnabled ? globalLoaders : [];
  const filteredGlobalLoaders = visibleGlobalLoaders.filter((loader) => {
    if (!pagesSearch) return true;
    const q = pagesSearch.toLowerCase();
    return (
      loader.title.toLowerCase().includes(q) ||
      loader.key.toLowerCase().includes(q) ||
      loader.resolveType.toLowerCase().includes(q)
    );
  });
  const activeLoader = activeLoaderKey
    ? (globalLoaders.find((loader) => loader.key === activeLoaderKey) ?? null)
    : null;
  const normPath = normalizePagePath;
  // A loader isn't a page: null `currentPage` so the publish effect skips it.
  const currentPage =
    activeGlobalSection || activeLoaderKey
      ? null
      : findPageForPath(pages, currentPath, pinnedPageKey);
  const currentPageName = activeGlobalSection
    ? activeGlobalSection.name
    : (activeLoader?.title ?? currentPage?.name);
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
    virtualMcpId && branch
      ? {
          orgSlug: org.slug,
          virtualMcpId,
          branch,
          threadId: activeTaskId ?? null,
        }
      : null;

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

  // Fast Preview (gated by the CMS switch): render the site's REAL page on
  // `previewServerUrl`, carrying a `?__draft=` pointer the site's framework
  // resolves by pulling the merged decofile. Replaces POSTing the decofile at
  // `/live/previews`, which only deco's own runtime honoured and could only
  // render one component statically.
  //
  // Sandbox-less: the draft is served by Studio's decofile API — the pointer
  // carries the API authority + a signed token, and `version` is the branch
  // head commit sha from KEYS.decofileDraft (seeded by the decofile read,
  // bumped by every save). No sandbox, no SSE — a new version after a save is
  // still what re-navigates the frame.
  //
  // Autosave indicator: an in-flight block write shares navigation's top bar.
  const decofileWriting = useDecofileWriting(
    org.slug,
    virtualMcpId ?? "",
    branch ?? "",
  );
  // Computed BEFORE `display`: it is an input to that decision, so it must not
  // depend on `display.mode` in turn.
  const { url: draftPreviewUrl } = useFastPreviewDraftUrl(
    fastPreviewEnabled && virtualMcpId && branch
      ? {
          orgSlug: org.slug,
          virtualMcpId,
          branch,
          previewServerUrl: previewServerUrl ?? null,
          path: resolvedPath,
        }
      : null,
  );

  // The recorded previewUrl flips previewState to "iframe" as soon as the
  // sandbox handle exists — well before the public preview proxy is routable —
  // so the sandbox surface is gated on `progress.status` (boot no longer in
  // progress), not on `previewUrl` alone. `resolvePreviewDisplay` decides what
  // to paint: the sandbox iframe, the published site + a waking pill, or
  // (no production URL) the blocking booting overlay.
  // Coding sessions boot visibly: no production fallback → the boot console.
  const codingSession = projectDefaultsToCms && session.runtime === "sandbox";
  const display = resolvePreviewDisplay({
    previewState,
    progressStatus: progress.status,
    previewServerUrl,
    fastPreviewActive: fastPreviewEnabled,
    fastPreviewReady: !!draftPreviewUrl,
    codingSession,
  });
  const previewSurfaceActive = display.mode !== "none";

  // Origin of the "production" mode's base — an external, org-owned domain
  // (the published site), unlike "sandbox" mode's `iframeBase`, which is
  // always this app's own local sandbox-preview-proxy origin (already
  // allowed natively, no registration needed). `null` outside production
  // mode, or once no `iframeBase` is available yet.
  const productionOrigin =
    display.mode === "production" && display.iframeBase
      ? previewOrigin(display.iframeBase)
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

  // Origin of the in-iframe editor bridge — sandbox proxy, or the site's own origin under Fast Preview.
  const editorBridgeOrigin =
    display.mode === "production"
      ? productionOrigin
      : previewOrigin(previewUrl);

  /**
   * Fast Preview in-place editing: while the Blocks panel is open on a Fast
   * Preview (production) frame, edits refresh the frame by POSTing the merged
   * decofile to /live/previews (an in-place DOM swap, no commit, no reload — see
   * the `cms-editor::render` trigger below). The autosave commit still runs, but
   * its version bump must NOT reload the frame — that reload is the ~15s round
   * trip this path avoids — so the draft URL's version is pinned while editing in
   * place, and re-tracks live once the panel closes.
   */
  const inPlaceRenderEnabled =
    inset?.entity?.id === virtualMcpId &&
    inset.entity.metadata?.fastPreviewInPlace === true;
  const inPlaceRenderActive =
    display.mode === "production" &&
    fastPreviewEnabled &&
    inPlaceRenderEnabled &&
    blocksEditingEnabled &&
    editingMode === "blocks";
  const pinnedDraftUrlRef = useRef<string | null>(null);
  if (!inPlaceRenderActive) {
    // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- track the live draft URL while not editing in place; pin it while editing
    pinnedDraftUrlRef.current = draftPreviewUrl;
  }
  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- read the value pinned during this same render (written just above when inactive)
  const pinnedDraftUrl = pinnedDraftUrlRef.current;
  const effectiveDraftPreviewUrl = inPlaceRenderActive
    ? (pinnedDraftUrl ?? draftPreviewUrl)
    : draftPreviewUrl;

  const iframeSrc = withDecoFBT(
    display.mode === "sandbox"
      ? withVariantMatcherOverride(
          withDeviceHint(
            directPreviewUrl ??
              resolvePreviewUrl(resolvedPath, display.iframeBase!) ??
              display.iframeBase!,
            previewDeviceSize,
          ),
          workspace.state.variantOverride ?? [],
        )
      : display.mode === "production" && productionOriginReady
        ? // Fast Preview's draft route honours the variant matcher override like the sandbox dev server, so append it here too.
          withVariantMatcherOverride(
            withDeviceHint(
              // Waking pill up ⇒ no draft is renderable yet, so ask for published.
              withDraftPointer(
                directPreviewUrl ??
                  effectiveDraftPreviewUrl ??
                  resolvePreviewUrl(resolvedPath, display.iframeBase!) ??
                  display.iframeBase!,
                display.showWakingPill ? DRAFT_OFF : null,
              ),
              previewDeviceSize,
            ),
            workspace.state.variantOverride ?? [],
          )
        : null,
  );

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
  const productionOpenTabBase =
    draftPreviewUrl ??
    (display.iframeBase
      ? resolvePreviewUrl(resolvedPath, display.iframeBase)
      : null);
  const openInNewTabUrl =
    display.mode === "production"
      ? productionOpenTabBase
        ? withVariantMatcherOverride(
            productionOpenTabBase,
            workspace.state.variantOverride ?? [],
          )
        : null
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
    if (!sharedTarget || !sectionPreviewBase || !meta) return;
    if (sharedTarget.kind === "page") {
      const params = pathParamsByPage[sharedTarget.key] ?? {};
      intendedPathRef.current = fillPathTemplate(sharedTarget.path, params);
      setActiveGlobalSection(null);
      setActiveLoaderKey(null);
      setDirectPreviewUrl(null);
      setPinnedPageKey(sharedTarget.key);
      setCurrentPath(sharedTarget.path);
      persistLastPage({
        path: sharedTarget.path,
        pageKey: sharedTarget.key,
        params,
      });
    } else if (sharedTarget.kind === "loader") {
      intendedPathRef.current = null;
      setActiveGlobalSection(null);
      setActiveLoaderKey(sharedTarget.key);
      setDirectPreviewUrl(null);
    } else {
      const section = globalSections.find(
        (candidate) => candidate.key === sharedTarget.key,
      );
      if (section) {
        intendedPathRef.current = null;
        const livePageRt = findLivePageResolveType(meta);
        setActiveLoaderKey(null);
        setActiveGlobalSection(section);
        setDirectPreviewUrl(
          buildGlobalSectionPreviewUrl(
            sectionPreviewBase,
            livePageRt,
            section.key,
          ),
        );
      }
    }
    // oxlint-disable-next-line eslint-plugin-react-hooks/exhaustive-deps -- derived helpers must not retrigger selection synchronization every render
  }, [sharedTarget, sectionPreviewBase, meta, pathParamsByPage]);

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
      setActiveLoaderKey(null);
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
      setActiveLoaderKey(null);
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

  // Post the current page's merged decofile to the frame for an in-place render.
  const renderPreviewInPlace = () => {
    const win = previewIframeRef.current?.contentWindow;
    const origin = editorBridgeOrigin;
    if (!win || !origin || !decofile || !currentPageKey) return;
    const pageBlock = decofile[currentPageKey];
    if (!pageBlock || typeof pageBlock !== "object") return;
    const req = buildPageRenderRequest({
      previewBaseUrl: origin,
      pageBlock: pageBlock as Record<string, unknown>,
      decofile: decofile as Record<string, unknown>,
      path: resolvedPath,
      pathTemplate: currentPath,
    });
    if (!req) return;
    // Carry the selected variant like the reload-based `iframeSrc` does; else the runtime renders the default variant.
    const src = withVariantMatcherOverride(
      req.src,
      workspace.state.variantOverride ?? [],
    );
    win.postMessage(
      { type: "cms-editor::render", src, body: req.body },
      origin,
    );
  };

  /**
   * Refresh the in-place render on a content or page/path change. The frame's
   * `src` is pinned here, so a page switch can't navigate it — the signature
   * folds in page + path to fire a render, deduped so onMutate + onSuccess
   * render once.
   */
  const renderSigRef = useRef<string | null>(null);
  // oxlint-disable-next-line ban-use-effect/ban-use-effect -- imperative postMessage refresh of a cross-origin frame on content/page change
  useEffect(() => {
    if (
      !inPlaceRenderActive ||
      activeGlobalSection ||
      activeLoaderKey ||
      !currentPageKey ||
      !decofile
    ) {
      renderSigRef.current = null;
      return;
    }
    const sig = JSON.stringify({
      page: currentPageKey,
      path: resolvedPath,
      pathTemplate: currentPath,
      decofile,
    });
    if (renderSigRef.current === sig) return;
    const isBaseline = renderSigRef.current === null;
    renderSigRef.current = sig;
    // The frame already shows this content via its src; only edits after it render.
    if (isBaseline) return;
    renderPreviewInPlace();
    // oxlint-disable-next-line eslint-plugin-react-hooks/exhaustive-deps -- renderPreviewInPlace reads live values; retrigger only on content/page change
  }, [
    decofile,
    inPlaceRenderActive,
    activeGlobalSection,
    activeLoaderKey,
    currentPageKey,
    resolvedPath,
    currentPath,
  ]);

  /**
   * Re-run the in-place render on a variant switch. Under Fast Preview in-place
   * mode the frame is pinned (no reload on the reload-based `iframeSrc`), and a
   * variant switch only changes `x-deco-matchers-override` — a query param, not
   * the decofile — so the content-change effect above never fires for it. Post a
   * fresh `/live/previews` render instead, so each variant selection reaches the
   * frame. Page-scoped baseline: a page switch (which clears the override) is not
   * a switch to render — the frame's own src already carries the new page's variant.
   */
  const variantRenderRef = useRef<{ page: string; sig: string } | null>(null);
  // oxlint-disable-next-line ban-use-effect/ban-use-effect -- imperative in-place re-render on variant change; the pinned frame won't reload
  useEffect(() => {
    if (
      !inPlaceRenderActive ||
      activeGlobalSection ||
      activeLoaderKey ||
      !currentPageKey ||
      !decofile
    ) {
      variantRenderRef.current = null;
      return;
    }
    const sig = JSON.stringify(workspace.state.variantOverride ?? null);
    const prev = variantRenderRef.current;
    variantRenderRef.current = { page: currentPageKey, sig };
    // Baseline (first run or page switch): the frame's src already reflects this variant.
    if (!prev || prev.page !== currentPageKey || prev.sig === sig) return;
    renderPreviewInPlace();
    // oxlint-disable-next-line eslint-plugin-react-hooks/exhaustive-deps -- renderPreviewInPlace reads live values; retrigger only on variant change
  }, [
    workspace.state.variantOverride,
    inPlaceRenderActive,
    activeGlobalSection,
    activeLoaderKey,
    currentPageKey,
  ]);

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
  const effectiveEditingMode = resolveEffectivePreviewEditingMode({
    editingMode,
    sandboxDisplay: display.mode === "sandbox",
    blocksEditingEnabled,
  });

  // oxlint-disable-next-line ban-use-effect/ban-use-effect — DOM event subscription
  useEffect(() => {
    const allowedOrigin = editorBridgeOrigin;
    if (!allowedOrigin) return;
    const handler = (e: MessageEvent) => {
      if (e.origin !== allowedOrigin) return;
      if (e.data?.type === "visual-editor::element-clicked") {
        const result = VisualEditorPayloadSchema.safeParse(e.data.payload);
        if (result.success) setVisualElement(result.data);
      } else if (e.data?.type === "cms-editor::section-clicked") {
        const result = CmsEditorPayloadSchema.safeParse(e.data.payload);
        if (result.success)
          setCmsSelectedSection({
            index: result.data.sectionIndex,
            seq: result.data.clickSeq,
          });
      } else if (e.data?.type === "cms-editor::render-start") {
        beginNavigation();
      } else if (e.data?.type === "cms-editor::render-end") {
        endNavigation();
        // The in-place swap keeps stale label/kind/key data; resend it.
        const win = previewIframeRef.current?.contentWindow;
        win?.postMessage(
          {
            type: "cms-editor::set-labels",
            labels: cmsSectionLabels,
            kinds: cmsSectionKinds,
            keys: cmsSectionKeys,
          },
          allowedOrigin,
        );
      } else if (e.data?.type === "cms-editor::render-error") {
        endNavigation();
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [editorBridgeOrigin, cmsSectionLabels, cmsSectionKinds, cmsSectionKeys]);

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
    const origin = editorBridgeOrigin;
    if (!win || !origin) return;
    // Sandbox speaks the daemon's `visual-editor::activate`; a Fast Preview production frame speaks the deco framework's `editor::inject`.
    win.postMessage(
      display.mode === "production"
        ? { type: "editor::inject", args: { script: CMS_EDITOR_SCRIPT } }
        : { type: "visual-editor::activate", script: CMS_EDITOR_SCRIPT },
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
    const origin = editorBridgeOrigin;
    if (!win || !origin) return;
    win.postMessage({ type: "cms-editor::deactivate" }, origin);
  };

  const activateEditingMode = (mode: PreviewEditingMode) => {
    if (mode === "blocks" && !blocksEditingEnabled) return;
    const previousMode = editingMode;
    if (!isMobile && mode !== previousMode) {
      if (mode === "blocks") blocksPanelRef.current?.resize("30%");
      else blocksPanelRef.current?.collapse();
    }
    // The JSON side panel only makes sense next to the Blocks editor.
    if (mode !== "blocks") closeJsonPanel();
    setEditingMode(mode);
    setVisualElement(null);
    setCmsSelectedSection(null);
    // A loader has no canvas, so leaving Blocks deselects it back to the page.
    if (mode !== "blocks") setActiveLoaderKey(null);
    if (previousMode === "visual") deactivateVisualEditor();
    if (mode === "visual") injectVisualEditor();
    if (previousMode === "blocks" && mode !== "blocks") deactivateCmsEditor();
    if (mode === "blocks") injectCmsEditor();
  };

  const toggleVisualEditing = () => {
    activateEditingMode(
      toggleVisualEditingMode(editingMode, blocksEditingEnabled),
    );
  };

  const handleRefresh = () => {
    if (!previewIframeRef.current || !iframeSrc) return;
    // Same progress bar as page navigation; the iframe's onLoad clears it.
    beginNavigation();
    const iframe = previewIframeRef.current;
    // biome-ignore lint/correctness/noSelfAssign: reloads the iframe
    // oxlint-disable-next-line no-self-assign
    iframe.src = iframeSrc;
  };

  /** Reload the preview without moving keyboard focus. */
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

  // Only a moved or restarted dev server; file edits reload the page themselves.
  useSandboxReloadHandler(reloadPreviewPreservingScroll);

  const handleDeviceToggle = () => {
    const idx = DEVICE_CYCLE.indexOf(previewDeviceSize);
    setPreviewDeviceSize(DEVICE_CYCLE[(idx + 1) % DEVICE_CYCLE.length]!);
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

  // Toolbar visibility follows main's display model: shown once an iframe
  // surface is active — the sandbox once its daemon is up, or the production
  // fallback while the dev server is still waking (see resolvePreviewDisplay).
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
    setActiveLoaderKey(null);
    setDirectPreviewUrl(null);
    // A click-through index from the previous page must not auto-select on the
    // next page's remounted editor.
    setCmsSelectedSection(null);
    setPinnedPageKey(page.key);
    setCurrentPath(page.path);
    persistLastPage({ path: page.path, pageKey: page.key, params });
    workspace.selectTarget({
      kind: "page",
      key: page.key,
      path: page.path,
    });
  };

  const navigatePreviewToGlobalSection = (section: GlobalSectionEntry) => {
    if (!sectionPreviewBase || !meta) {
      toast.error(t("sandbox.preview.previewMetadataNotReady"));
      return;
    }
    beginNavigation();
    intendedPathRef.current = null;
    const livePageRt = findLivePageResolveType(meta);
    const url = buildGlobalSectionPreviewUrl(
      sectionPreviewBase,
      livePageRt,
      section.key,
    );
    setActiveGlobalSection(section);
    setActiveLoaderKey(null);
    setDirectPreviewUrl(url);
    setCmsSelectedSection(null);
    workspace.selectTarget({ kind: "section", key: section.key });
  };

  // Loaders open full-width in the Blocks panel (form + Run), no canvas.
  const navigatePreviewToLoader = (loader: SavedRunnableEntry) => {
    if (!blocksEditingEnabled) return;
    setActiveGlobalSection(null);
    setActiveLoaderKey(loader.key);
    setDirectPreviewUrl(null);
    activateEditingMode("blocks");
    workspace.selectTarget({ kind: "loader", key: loader.key });
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

  const showPreviewToolbar =
    previewSurfaceActive && (daemonReady || display.mode === "production");

  /** The page selector shares the exact project-level gate used by Content and
   *  Blocks. Session runtime and metadata readiness do not change the topbar's
   *  shape; the selector can expose setup/creation flows while data loads. */
  const pageSelectorVisible = showCmsPageSelector({
    showPreviewToolbar,
    contentEditingEnabled,
  });

  /** Refresh · what-the-frame-is-showing · open-in-new, kept as one block so
   *  desktop can put it in the header's centre slot and mobile in its own. The
   *  middle always renders; `pageSelectorVisible` decides whether it is the
   *  interactive page selector or a plain domain label. */
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

      {/* The topbar always names what the iframe is showing; only HOW differs
          by the shared content-editing gate. Enabled projects get the page
          selector — page name, editable `:param` segments, and the dropdown
          that also hosts "Create page". Disabled projects get the iframe's
          domain as plain text. */}
      {pageSelectorVisible ? (
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
              {activeLoader && (
                <span className="shrink-0 inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                  <Database01 size={11} />
                  {t("sandbox.preview.loaderBadge")}
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
              {!activeGlobalSection &&
                !activeLoaderKey &&
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
                      // Params with a source render as a modal chip; rest inline.
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
              aria-expanded={pagesOpen}
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
              filteredGlobalSections.length === 0 &&
              filteredGlobalLoaders.length === 0 ? (
                <div className="px-4 py-5 text-center text-xs text-muted-foreground">
                  {pages.length === 0 &&
                  globalSections.length === 0 &&
                  visibleGlobalLoaders.length === 0
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
                  {filteredGlobalLoaders.length > 0 && (
                    <div
                      className={cn(
                        "p-1.5",
                        (filteredPages.length > 0 ||
                          filteredGlobalSections.length > 0) &&
                          "border-t",
                      )}
                    >
                      <div className="px-3 py-2 text-xs font-medium text-muted-foreground">
                        {t("sandbox.preview.globalLoaders")}
                      </div>
                      {filteredGlobalLoaders.map((loader) => (
                        <button
                          key={loader.key}
                          type="button"
                          className="flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
                          onMouseDown={(e) => {
                            e.preventDefault();
                            setPagesOpen(false);
                            setPagesSearch("");
                            navigatePreviewToLoader(loader);
                          }}
                        >
                          <Database01
                            size={16}
                            className="shrink-0 text-muted-foreground"
                          />
                          <span className="min-w-0 flex-1 truncate font-medium">
                            {loader.title}
                          </span>
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {loader.resolveType
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
      ) : (
        <span className="min-w-0 truncate px-2 text-[13px] text-muted-foreground">
          {previewLabel}
        </span>
      )}
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

  // Desktop composition (portaled into the panel header's centre slot).
  const urlControls = urlGroup ? (
    <div className="flex min-w-0 items-center gap-0.5">{urlGroup}</div>
  ) : null;
  const canVisualEdit = display.mode === "sandbox";

  // Desktop stays fluid until the canvas is narrower than its logical width; then (and always for mobile/tablet) the frame scales to fit.
  const previewViewport = PREVIEW_VIEWPORTS[previewDeviceSize];
  const previewFluid =
    previewDeviceSize === "desktop" &&
    (canvasSize.width === 0 ||
      canvasSize.width >= previewViewport.width + 2 * PREVIEW_OFFSET);
  const previewScale = previewFluid
    ? 1
    : Math.min(
        canvasSize.width > 0
          ? canvasSize.width / (previewViewport.width + 2 * PREVIEW_OFFSET)
          : 1,
        1,
      );
  const previewFrameStyle: CSSProperties = previewFluid
    ? { width: "100%", height: "100%" }
    : {
        width: `${previewViewport.width}px`,
        height:
          canvasSize.height > 0
            ? `${canvasSize.height / previewScale}px`
            : `${previewViewport.height}px`,
        transform: `scale(${previewScale})`,
        transformOrigin: "top center",
      };

  // Device toggle works on any live iframe; visual-editor toggle is sandbox-only.
  const floatingPreviewControls = previewSurfaceActive ? (
    <div className="absolute bottom-4 left-1/2 z-20 -translate-x-1/2 scale-125">
      <div className="flex items-center gap-0.5 rounded-full border bg-background/60 p-1 shadow-lg backdrop-blur-md">
        {canVisualEdit && (
          <>
            <Tooltip>
              <TooltipTrigger asChild>
                <ToolbarIconButton
                  onClick={toggleVisualEditing}
                  aria-pressed={effectiveEditingMode === "visual"}
                  aria-label={t("sandbox.preview.visualEditor")}
                  active={effectiveEditingMode === "visual"}
                  className="rounded-full"
                >
                  <CursorClick01 size={16} />
                </ToolbarIconButton>
              </TooltipTrigger>
              <TooltipContent side="top">
                {t("sandbox.preview.visualEditor")}
              </TooltipContent>
            </Tooltip>
            <div className="mx-0.5 h-5 w-px bg-border" />
          </>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <ToolbarIconButton
              onClick={handleDeviceToggle}
              aria-label={t(DEVICE_LABEL_KEYS[previewDeviceSize])}
              className="rounded-full"
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

  // A loader has no canvas, so its desktop Blocks form uses the whole panel.
  const blocksFullWidth =
    !!activeLoaderKey && effectiveEditingMode === "blocks";

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
              sources={sources}
              template={currentPath}
              paramName={name}
              sandboxRef={pickerSandboxRef}
              onFill={(value) => setPathParamValue(name, value)}
            />
          ) : null,
        )}
      {headerSlot
        ? urlControls && (
            <MainPanelHeaderPortal>{urlControls}</MainPanelHeaderPortal>
          )
        : urlGroup && (
            /* Declares the same container as PanelHeader: without a header slot
             (mobile or a standalone desktop surface), the controls render
             inline instead of portaling. Without it their container queries
             would find no container and every label would stay at full width.

             Equal empty side zones keep the content-sized URL group centered
             on the bar wherever there is room. */
            <div className="@container/panel-header relative flex h-12 shrink-0 items-center gap-2 border-b border-border/60 px-3 md:px-4">
              <div className="flex-1" />
              <div className="flex min-w-0 shrink items-center justify-center gap-0.5">
                {urlGroup}
              </div>
              <div className="flex-1" />
            </div>
          )}

      <div className="flex-1 overflow-hidden">
        {blocksFullWidth ? (
          <div className="relative h-full min-h-0 overflow-hidden">
            <BlocksPanel
              virtualMcpId={virtualMcpId}
              externalSelection={cmsSelectedSection}
              onViewJsonFile={toggleJsonPanel}
            />
            {jsonPanelOpen && currentPageKey && (
              <div className="absolute inset-0 z-10">
                <PageJsonPanel
                  ref={jsonPanelHandleRef}
                  virtualMcpId={virtualMcpId}
                  pageKey={currentPageKey}
                  onClose={closeJsonPanel}
                />
              </div>
            )}
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
                  externalSelection={cmsSelectedSection}
                  onViewJsonFile={toggleJsonPanel}
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
              <ResizablePanelGroup
                orientation="horizontal"
                disabled={!(jsonPanelOpen && currentPageKey)}
              >
                {jsonPanelOpen && currentPageKey && (
                  <>
                    <ResizablePanel
                      id="preview-json-editor"
                      defaultSize="43%"
                      minSize="20%"
                      className="min-w-0 overflow-hidden"
                    >
                      <PageJsonPanel
                        ref={jsonPanelHandleRef}
                        virtualMcpId={virtualMcpId}
                        pageKey={currentPageKey}
                        onClose={closeJsonPanel}
                      />
                    </ResizablePanel>
                    <ResizableHandle withHandle />
                  </>
                )}
                <ResizablePanel
                  id="preview-canvas-inner"
                  minSize="30%"
                  className="min-w-0 overflow-hidden"
                >
                  <div
                    ref={(node) => {
                      if (!node) return;
                      const measure = () =>
                        setCanvasSize((prev) =>
                          prev.width === node.clientWidth &&
                          prev.height === node.clientHeight
                            ? prev
                            : {
                                width: node.clientWidth,
                                height: node.clientHeight,
                              },
                        );
                      measure();
                      const observer = new ResizeObserver(measure);
                      observer.observe(node);
                      return () => observer.disconnect();
                    }}
                    className={cn(
                      // `overflow-clip`, not `hidden`: the scaled frame's layout box outgrows this container, and a scroll port would let the browser scroll it to reveal a focused descendant (section select), jumping the preview up.
                      "h-full relative overflow-clip flex justify-center",
                      previewSurfaceActive && !previewFluid && "bg-muted/30",
                    )}
                  >
                    {/* Asymptotic "commit ramp" progress: brand lime fill over a
                    transparent track — no strip across the site, just the
                    moving edge itself, with a soft same-color glow for
                    presence on busy content. */}
                    {(navigating || decofileWriting) &&
                      previewSurfaceActive && (
                        <div className="absolute inset-x-0 top-0 z-40 h-1 overflow-hidden">
                          <div className="absolute inset-y-0 left-0 rounded-r-full bg-brand shadow-[0_0_6px] shadow-brand/60 animate-preview-ramp" />
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
                        <Spinner className="size-4.5 mt-0.5 shrink-0 text-muted-foreground" />
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
                          "shrink-0",
                          !previewFluid &&
                            "border-x border-border bg-background shadow-sm",
                        )}
                        style={previewFrameStyle}
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
                            // Production (Fast Preview) frame is cross-origin: skip the sandbox-only load handling, but the site's real pages still take the CMS overlay via the framework's `editor::inject` listener.
                            if (display.mode !== "sandbox") {
                              if (
                                display.mode === "production" &&
                                !display.showWakingPill &&
                                effectiveEditingMode === "blocks"
                              ) {
                                injectCmsEditor();
                              }
                              return;
                            }
                            // This is the VM dev-server preview (sandboxed running app),
                            // NOT an MCP app. MCP apps render via <MCPAppRenderer/>.
                            track("vm_preview_loaded", {
                              view_mode: effectiveEditingMode,
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
                                  previewIframeRef.current?.contentWindow
                                    ?.location?.pathname;
                                if (!iframePath) return;
                                const intended = intendedPathRef.current;
                                if (intended !== null) {
                                  intendedPathRef.current = null;
                                  // Stale onLoad from the previous URL — ignore.
                                  if (
                                    normPath(iframePath) !== normPath(intended)
                                  ) {
                                    return;
                                  }
                                }
                                // Keep the template as currentPath when the loaded
                                // path is just the template with params filled in —
                                // otherwise the page match and param inputs are lost.
                                if (
                                  normPath(iframePath) ===
                                  normPath(resolvedPath)
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
                            if (effectiveEditingMode === "visual") {
                              injectVisualEditor();
                            }
                            if (effectiveEditingMode === "blocks") {
                              injectCmsEditor();
                            }
                          }}
                        />
                      </div>
                    )}
                  </div>
                </ResizablePanel>
              </ResizablePanelGroup>
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
