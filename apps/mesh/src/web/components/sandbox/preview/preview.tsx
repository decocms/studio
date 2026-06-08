import { useState, useRef, useEffect, Suspense, lazy } from "react";
import { useInsetContext } from "@/web/layouts/agent-shell-layout";
import { useChatTask } from "@/web/components/chat/context";
import { useProjectContext } from "@decocms/mesh-sdk";
import { useSandboxLifecycle } from "@/web/components/sandbox/hooks/sandbox-lifecycle-context";

import {
  ChevronDown,
  Code02,
  CursorClick01,
  DotsHorizontal,
  Globe02,
  LayoutAlt01,
  LinkExternal01,
  Plus,
  SearchLg,
  TextInput,
  Loading01,
  Monitor04,
  RefreshCw01,
} from "@untitledui/icons";
import { cn } from "@deco/ui/lib/utils.js";
import { Button } from "@deco/ui/components/button.tsx";
import {
  ViewModeToggle,
  type ViewModeOption,
} from "@deco/ui/components/view-mode-toggle.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@deco/ui/components/dropdown-menu.tsx";
import { useDecofile } from "@/web/components/sections-editor/use-decofile";
import { useLiveMeta } from "@/web/components/sections-editor/use-live-meta";
import {
  extractGlobalSections,
  extractPages,
  hasEditableDecoContent,
  type GlobalSectionEntry,
} from "@/web/components/sections-editor/page-list";
import {
  normalizePagePath,
  validatePagePath,
} from "@/web/components/sections-editor/page-path-utils";
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
import { VisualEditorPrompt } from "./visual-editor-prompt";
import {
  useSandboxEvents,
  useSandboxReloadHandler,
} from "../hooks/use-sandbox-events";
import { SandboxStateCard } from "./state-card";
import { derivePhaseProgress } from "./derive-phase-progress";
import { track } from "@/web/lib/posthog-client";

const SectionsEditor = lazy(() =>
  import("@/web/components/sections-editor/sections-editor").then((m) => ({
    default: m.SectionsEditor,
  })),
);

const FileExplorer = lazy(() =>
  import("./file-explorer/file-explorer").then((m) => ({
    default: m.FileExplorer,
  })),
);

/** Delay before reloading the preview iframe after a save, giving the dev server time to pick up file changes. */
const DEV_SERVER_SETTLE_MS = 500;

type PreviewViewMode = "preview" | "visual" | "cms" | "code";

export function PreviewContent() {
  const inset = useInsetContext();
  const { currentBranch: branch } = useChatTask();

  // Visual editor state
  const [viewMode, setViewMode] = useState<PreviewViewMode>("preview");
  const [visualElement, setVisualElement] =
    useState<VisualEditorPayload | null>(null);
  const previewIframeRef = useRef<HTMLIFrameElement>(null);

  // Sections editor panel
  const sectionsOpen = viewMode === "cms";
  const [cmsSelectedSectionIndex, setCmsSelectedSectionIndex] = useState<
    number | null
  >(null);
  const [panelWidth, setPanelWidth] = useState(384);
  const isResizingRef = useRef(false);
  const resizeStartXRef = useRef(0);
  const resizeStartWidthRef = useRef(0);
  // Tracks the last focused element outside the iframe so we can restore it
  // when the iframe reload steals focus.
  const focusBeforeIframeRef = useRef<HTMLElement | null>(null);

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

  const virtualMcpId = inset?.entity?.id ?? null;
  const { org } = useProjectContext();

  const vmEvents = useSandboxEvents();
  const lifecycle = useSandboxLifecycle();
  const vmEntry = lifecycle.vmEntry;
  const previewUrl = lifecycle.previewUrl;
  const lifecyclePhase = vmEvents.lifecycle.phase;
  const devServerReady = lifecyclePhase === "running";

  // Decofile pages for the URL bar dropdown — fetch only after dev server is up.
  const decofileParams =
    virtualMcpId && branch && devServerReady
      ? { orgSlug: org.slug, virtualMcpId, branch }
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
  const currentPageName = activeGlobalSection
    ? activeGlobalSection.name
    : pages.find((p) => normPath(p.path) === normPath(currentPath))?.name;

  const iframeSrcRef = useRef<string | null>(null);
  /** Path we navigated to programmatically; ignore stale iframe onLoad events. */
  const intendedPathRef = useRef<string | null>(null);

  // "reload" fires on config edits framework HMR won't catch (.ts/.tsx use HMR).
  useSandboxReloadHandler(() => {
    const iframe = previewIframeRef.current;
    const src = iframeSrcRef.current;
    if (!iframe || !src) return;
    iframe.src = src;
  });

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

  const iframeSrc =
    previewState.kind === "iframe"
      ? (directPreviewUrl ?? new URL(currentPath, previewState.previewUrl).href)
      : null;

  // Reset navigation when the VM preview base URL changes (branch switch, etc.)
  const [prevIframeBase, setPrevIframeBase] = useState<string | null>(null);
  if (
    previewState.kind === "iframe" &&
    prevIframeBase !== previewState.previewUrl
  ) {
    const hadPreviousBase = prevIframeBase !== null;
    setPrevIframeBase(previewState.previewUrl);
    if (hadPreviousBase) {
      // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- clear stale navigation intent on branch switch
      intendedPathRef.current = null;
      setCurrentPath("/");
      setDirectPreviewUrl(null);
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

  // `visual` and `cms` drop out of the toggle options when the iframe is
  // gone (they require a live dev server to inject overlays into). Fall
  // back to `preview` for the toggle binding + overlay renders so the
  // toggle never carries a value not in its option list.
  const effectiveViewMode: PreviewViewMode =
    previewState.kind !== "iframe" &&
    (viewMode === "visual" || viewMode === "cms")
      ? "preview"
      : viewMode;

  // oxlint-disable-next-line ban-use-effect/ban-use-effect — DOM event subscription
  useEffect(() => {
    if (!previewUrl) return;
    let allowedOrigin: string;
    try {
      allowedOrigin = new URL(previewUrl, window.location.href).origin;
    } catch {
      return;
    }
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

  // Prevent the iframe from stealing focus away from sections-editor inputs.
  // When focus leaves an element and lands on the iframe (or body, which
  // happens for cross-origin iframe focus), restore the previously focused
  // element. We track the last non-iframe focused element via `focusin`, and
  // detect the steal via a rAF after `blur` (by that time activeElement has
  // settled to body/iframe when focus entered the iframe content window).
  // oxlint-disable-next-line ban-use-effect/ban-use-effect — DOM event subscription for focus tracking
  useEffect(() => {
    if (!sectionsOpen) return;

    const onFocusIn = (e: FocusEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && target !== previewIframeRef.current) {
        focusBeforeIframeRef.current = target;
      }
    };

    const onBlur = () => {
      requestAnimationFrame(() => {
        const active = document.activeElement;
        // When focus enters a cross-origin iframe, activeElement becomes
        // <body> or the <iframe> element itself.
        if (
          (active === document.body || active === previewIframeRef.current) &&
          focusBeforeIframeRef.current
        ) {
          focusBeforeIframeRef.current.focus();
        }
      });
    };

    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("blur", onBlur, true);
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("blur", onBlur, true);
    };
  }, [sectionsOpen]);

  const injectVisualEditor = () => {
    const win = previewIframeRef.current?.contentWindow;
    if (!win) return;
    win.postMessage(
      { type: "visual-editor::activate", script: VISUAL_EDITOR_SCRIPT },
      "*",
    );
  };

  const deactivateVisualEditor = () => {
    const win = previewIframeRef.current?.contentWindow;
    if (!win) return;
    win.postMessage({ type: "visual-editor::deactivate" }, "*");
  };

  const injectCmsEditor = () => {
    const win = previewIframeRef.current?.contentWindow;
    if (!win) return;
    win.postMessage(
      { type: "visual-editor::activate", script: CMS_EDITOR_SCRIPT },
      "*",
    );
  };

  const deactivateCmsEditor = () => {
    const win = previewIframeRef.current?.contentWindow;
    if (!win) return;
    win.postMessage({ type: "cms-editor::deactivate" }, "*");
  };

  const handleViewModeChange = (mode: PreviewViewMode) => {
    const prev = viewMode;
    setViewMode(mode);
    setVisualElement(null);
    if (mode !== "cms") setCmsSelectedSectionIndex(null);
    if (prev === "visual") deactivateVisualEditor();
    if (prev === "cms") deactivateCmsEditor();
    if (mode === "visual") injectVisualEditor();
    if (mode === "cms") injectCmsEditor();
  };

  const handleRefresh = () => {
    if (!previewIframeRef.current || !iframeSrc) return;
    const iframe = previewIframeRef.current;
    // biome-ignore lint/correctness/noSelfAssign: reloads the iframe
    // oxlint-disable-next-line no-self-assign
    iframe.src = iframeSrc;
  };

  const handleHardReload = () => {
    if (!previewIframeRef.current || !iframeSrc) return;
    const sep = iframeSrc.includes("?") ? "&" : "?";
    previewIframeRef.current.src = `${iframeSrc}${sep}_r=${Date.now()}`;
  };

  const handleCopyUrl = () => {
    const url =
      previewIframeRef.current?.contentWindow?.location?.href ??
      iframeSrc ??
      previewUrl;
    if (url) navigator.clipboard.writeText(url);
  };

  const previewLabel = (() => {
    if (!previewUrl) return "No server running";
    if (activeGlobalSection) return activeGlobalSection.name;
    try {
      const url = new URL(previewUrl);
      const path = currentPath === "/" ? "" : currentPath;
      return `${url.host}${path}`;
    } catch {
      return previewUrl;
    }
  })();

  const navigatePreviewToPage = (path: string) => {
    intendedPathRef.current = path;
    setActiveGlobalSection(null);
    setDirectPreviewUrl(null);
    setCurrentPath(path);
    setCmsSelectedSectionIndex(null);
  };

  const navigatePreviewToGlobalSection = (section: GlobalSectionEntry) => {
    if (!previewUrl || !meta) {
      toast.error("Preview metadata not ready yet");
      return;
    }
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
  };

  const handleCreatePage = async ({
    name,
    path,
  }: {
    name: string;
    path: string;
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
      setCreatePageError(`A page with path "${trimmedPath}" already exists.`);
      return;
    }
    setCreatePageError(undefined);
    try {
      const result = await createPage.mutateAsync({
        name,
        path: trimmedPath,
      });
      setCreatePageDialogOpen(false);
      toast.success(`Page "${name}" created`);
      await new Promise((resolve) => setTimeout(resolve, DEV_SERVER_SETTLE_MS));
      navigatePreviewToPage(result.path);
      handleViewModeChange("cms");
    } catch (error) {
      setCreatePageError(
        error instanceof Error ? error.message : "Failed to create page",
      );
    }
  };

  // visual + cms require a live iframe (they inject overlays into the dev
  // server); when the iframe isn't up we still offer preview + code so the
  // user can browse files after a dev-script crash.
  const viewModeOptions: ViewModeOption<PreviewViewMode>[] = [
    { value: "preview", icon: <Monitor04 size={14} />, tooltip: "Interactive" },
    ...(previewState.kind === "iframe"
      ? [
          {
            value: "visual" as PreviewViewMode,
            icon: <CursorClick01 size={14} />,
            tooltip: "Visual editor",
          },
        ]
      : []),
    ...(previewState.kind === "iframe" && hasEditableDecoContent(decofile, meta)
      ? [
          {
            value: "cms" as PreviewViewMode,
            icon: <TextInput size={14} />,
            tooltip: "Sections editor",
          },
        ]
      : []),
    { value: "code", icon: <Code02 size={14} />, tooltip: "Code editor" },
  ];

  return (
    <div className="flex flex-col w-full h-full">
      {daemonReady && (
        <div className="flex h-12 shrink-0 items-center gap-4 border-b border-border/60 px-3 md:px-4">
          {/* Group 1: view mode toggle. Always visible when the daemon is up
              so the user can drop into code mode after a dev-script crash. */}
          <div className="flex shrink-0 items-center gap-1">
            <ViewModeToggle
              value={effectiveViewMode}
              onValueChange={handleViewModeChange}
              options={viewModeOptions}
              size="sm"
              className="shrink-0 bg-foreground/4.5"
            />
          </div>

          {/* Groups 2+3 only render when the iframe is live — they read
              `previewState.previewUrl` and steer the iframe directly. */}
          {previewState.kind === "iframe" && (
            <>
              {/* Group 2: nav + url (hidden in code mode) */}
              <div
                className={cn(
                  "flex min-w-0 flex-1 items-center gap-0.5",
                  viewMode === "code" && "hidden",
                )}
              >
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon" onClick={handleRefresh}>
                      <RefreshCw01 size={14} />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">Refresh</TooltipContent>
                </Tooltip>

                <div
                  ref={pagesContainerRef}
                  className="relative min-w-0 flex-1"
                >
                  <button
                    type="button"
                    className="flex h-8 w-full min-w-0 items-center gap-1 rounded-md bg-background px-2 transition-colors duration-200 hover:bg-accent"
                    onClick={() => setPagesOpen((prev) => !prev)}
                  >
                    {activeGlobalSection && (
                      <span className="shrink-0 inline-flex items-center gap-1 rounded bg-global-section/14 px-1.5 py-0.5 text-[11px] font-medium text-global-section-fg dark:text-global-section-fg-dark">
                        <Globe02 size={11} />
                        Global
                      </span>
                    )}
                    <span className="min-w-0 flex-1 truncate text-left text-[12px] text-foreground/88">
                      {previewLabel}
                    </span>
                    {currentPageName && !activeGlobalSection && (
                      <span className="shrink-0 text-[12px] text-muted-foreground">
                        {currentPageName}
                      </span>
                    )}
                    <ChevronDown
                      size={12}
                      className={cn(
                        "shrink-0 text-muted-foreground transition-transform",
                        pagesOpen && "rotate-180",
                      )}
                    />
                  </button>

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
                          placeholder="Search pages and components..."
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
                            Create new page
                          </span>
                        </button>
                      </div>
                      {filteredPages.length === 0 &&
                      filteredGlobalSections.length === 0 ? (
                        <div className="px-4 py-5 text-center text-xs text-muted-foreground">
                          {pages.length === 0 && globalSections.length === 0
                            ? "No pages found in this site."
                            : "No results match your search."}
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
                                    navigatePreviewToPage(page.path);
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
                                Global components
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
              </div>

              {/* Group 3: open in new tab + more actions (hidden in code mode) */}
              <div
                className={cn(
                  "flex shrink-0 items-center gap-0.5",
                  viewMode === "code" && "hidden",
                )}
              >
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => {
                        const url = iframeSrc ?? previewState.previewUrl;
                        if (url) window.open(url, "_blank", "noopener");
                      }}
                    >
                      <LinkExternal01 size={14} />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">Open in new tab</TooltipContent>
                </Tooltip>

                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon">
                      <DotsHorizontal size={14} />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={handleHardReload}>
                      Hard Reload
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={handleCopyUrl}>
                      Copy Current URL
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </>
          )}
        </div>
      )}

      <div className="flex-1 flex overflow-hidden">
        {/* Sections editor side panel (left) */}
        {sectionsOpen && previewUrl && branch && virtualMcpId && (
          <>
            <div
              className="shrink-0 border-r overflow-hidden"
              style={{ width: panelWidth }}
            >
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
                  orgSlug={org.slug}
                  virtualMcpId={virtualMcpId}
                  branch={branch}
                  previewReady={devServerReady}
                  previewUrl={previewUrl}
                  currentPath={currentPath}
                  activeGlobalBlockKey={activeGlobalSection?.key ?? null}
                  externalSelectedIndex={
                    activeGlobalSection ? null : cmsSelectedSectionIndex
                  }
                  onSaved={() => {
                    setTimeout(() => {
                      const iframe = previewIframeRef.current;
                      if (!iframe) return;
                      // Prevent iframe from stealing focus during reload
                      const focused =
                        document.activeElement as HTMLElement | null;
                      const prevTabIndex = iframe.tabIndex;
                      iframe.tabIndex = -1;
                      iframe.style.pointerEvents = "none";
                      iframe.blur();
                      try {
                        iframe.contentWindow?.location.reload();
                      } catch {
                        const src = iframeSrcRef.current;
                        if (src) iframe.src = src;
                      }
                      const restore = () => {
                        iframe.tabIndex = prevTabIndex;
                        iframe.style.pointerEvents = "";
                        focused?.focus();
                        iframe.removeEventListener("load", restore);
                      };
                      iframe.addEventListener("load", restore);
                      setTimeout(restore, 3000);
                    }, DEV_SERVER_SETTLE_MS);
                  }}
                />
              </Suspense>
            </div>
            <div
              className="w-1 shrink-0 cursor-col-resize bg-transparent hover:bg-border transition-colors"
              onPointerDown={(e) => {
                isResizingRef.current = true;
                resizeStartXRef.current = e.clientX;
                resizeStartWidthRef.current = panelWidth;
                e.currentTarget.setPointerCapture(e.pointerId);
              }}
              onPointerMove={(e) => {
                if (!isResizingRef.current) return;
                const delta = e.clientX - resizeStartXRef.current;
                setPanelWidth(
                  Math.max(
                    240,
                    Math.min(640, resizeStartWidthRef.current + delta),
                  ),
                );
              }}
              onPointerUp={() => {
                isResizingRef.current = false;
              }}
            />
          </>
        )}

        <div className="flex-1 relative overflow-hidden">
          {previewState.kind === "starting" && (
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
              <SandboxStateCard kind="suspended" onResume={lifecycle.resume} />
            </div>
          )}

          {effectiveViewMode === "visual" && !visualElement && (
            <div className="absolute top-2 left-1/2 -translate-x-1/2 z-20 flex items-center gap-1.5 rounded-full border border-violet-400/40 bg-violet-500/90 px-3 py-1 text-xs font-medium text-white shadow-md backdrop-blur-sm pointer-events-none select-none">
              <CursorClick01 size={12} />
              Click any element to ask the AI
            </div>
          )}
          {effectiveViewMode === "visual" && visualElement && (
            <VisualEditorPrompt
              element={visualElement}
              onDismiss={() => setVisualElement(null)}
            />
          )}
          {/* File explorer (code mode). Gated on daemon-ready, NOT on the
              dev server: the daemon's FS endpoints (/read, /glob, …) keep
              serving even when the dev script has crashed, so the user can
              still browse files to debug a `start-failed`. */}
          {viewMode === "code" && daemonReady && virtualMcpId && branch && (
            <div className="absolute inset-0 z-10 bg-background">
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
                <FileExplorer
                  orgSlug={org.slug}
                  virtualMcpId={virtualMcpId}
                  branch={branch}
                />
              </Suspense>
            </div>
          )}

          {previewState.kind === "iframe" && iframeSrc && (
            <iframe
              // Key on previewUrl: remount when the VM base URL changes (branch
              // switch). Path navigation is driven by `iframeSrc` state.
              key={previewState.previewUrl}
              ref={previewIframeRef}
              src={iframeSrc}
              className={cn(
                "w-full h-full border-0",
                viewMode === "code" && "invisible",
              )}
              title="Dev Server Preview"
              tabIndex={sectionsOpen ? -1 : undefined}
              onLoad={() => {
                // This is the VM dev-server preview (sandboxed running app),
                // NOT an MCP app. MCP apps render via <MCPAppRenderer/>.
                track("vm_preview_loaded", {
                  view_mode: viewMode,
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
                      if (normPath(iframePath) === normPath(intended)) {
                        setCurrentPath(iframePath);
                      }
                      return;
                    }
                    setCurrentPath(iframePath);
                  } catch {
                    // Cross-origin — can't read, keep current value
                  }
                }
                if (viewMode === "visual") injectVisualEditor();
                if (viewMode === "cms") injectCmsEditor();
              }}
            />
          )}
        </div>
      </div>
      <CreatePageModal
        open={createPageDialogOpen}
        onOpenChange={setCreatePageDialogOpen}
        isPending={createPage.isPending}
        error={createPageError}
        onSubmit={handleCreatePage}
      />
    </div>
  );
}
