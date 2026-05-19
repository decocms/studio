import { useState, useRef, useEffect, Suspense, lazy } from "react";
import { useInsetContext } from "@/web/layouts/agent-shell-layout";
import { authClient } from "@/web/lib/auth-client";
import { useChatTask } from "@/web/components/chat/context";
import {
  useMCPClient,
  useProjectContext,
  SELF_MCP_ALIAS_ID,
} from "@decocms/mesh-sdk";

import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  CursorClick01,
  DotsHorizontal,
  TextInput,
  LinkExternal01,
  Loading01,
  Monitor04,
  RefreshCw01,
  Server01,
} from "@untitledui/icons";
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
import { ScrollArea } from "@deco/ui/components/scroll-area.tsx";
import { useDecofile } from "@/web/components/sections-editor/use-decofile";
import { extractPages } from "@/web/components/sections-editor/page-list";
import {
  VISUAL_EDITOR_SCRIPT,
  VisualEditorPayloadSchema,
  type VisualEditorPayload,
} from "./visual-editor-script";
import { VisualEditorPrompt } from "./visual-editor-prompt";
import { useVmEvents, useVmReloadHandler } from "../hooks/use-vm-events";
import {
  useIsVmStartPending,
  useVmStart,
  vmUserStop,
  type VmStartArgs,
} from "../hooks/use-vm-start";
import { computePreviewState, type PreviewState } from "./preview-state";
import { VmStateCard } from "./state-card";
import { derivePhaseProgress } from "./derive-phase-progress";
import {
  PreviewDrawer,
  readPersistedDrawerOpen,
  writePersistedDrawerOpen,
} from "./drawer/drawer";
import type { DrawerStatus } from "./drawer/toolbar";
import { invalidateVirtualMcpQueries } from "@/web/lib/query-keys";
import { useQueryClient } from "@tanstack/react-query";
import { track } from "@/web/lib/posthog-client";

const SectionsEditor = lazy(() =>
  import("@/web/components/sections-editor/sections-editor").then((m) => ({
    default: m.SectionsEditor,
  })),
);

/** Delay before reloading the preview iframe after a save, giving the dev server time to pick up file changes. */
const DEV_SERVER_SETTLE_MS = 500;

function drawerStatusFromPreview(
  state: PreviewState,
  vmStartPending: boolean,
): DrawerStatus {
  if (state.kind === "errored") return "errored";
  if (state.kind === "suspended") return "suspended";
  if (state.kind === "starting-now" || vmStartPending) return "starting";
  if (
    state.kind === "iframe" ||
    state.kind === "no-html" ||
    state.kind === "crashed"
  )
    return "running";
  return "idle";
}

type PreviewViewMode = "preview" | "visual";

const VIEW_MODE_OPTIONS: [
  ViewModeOption<PreviewViewMode>,
  ViewModeOption<PreviewViewMode>,
] = [
  { value: "preview", icon: <Monitor04 size={14} />, tooltip: "Interactive" },
  {
    value: "visual",
    icon: <CursorClick01 size={14} />,
    tooltip: "Visual Editor",
  },
];

export function PreviewContent() {
  const inset = useInsetContext();
  const { data: session } = authClient.useSession();
  const { taskId, currentBranch: branch, setCurrentTaskBranch } = useChatTask();

  // Visual editor state
  const [viewMode, setViewMode] = useState<PreviewViewMode>("preview");
  const [visualElement, setVisualElement] =
    useState<VisualEditorPayload | null>(null);
  const previewIframeRef = useRef<HTMLIFrameElement>(null);

  // Sections editor panel
  const [sectionsOpen, setSectionsOpen] = useState(false);
  // Tracks the last focused element outside the iframe so we can restore it
  // when the iframe reload steals focus.
  const focusBeforeIframeRef = useRef<HTMLElement | null>(null);

  // Pages dropdown in URL bar
  const [pagesOpen, setPagesOpen] = useState(false);
  const pagesContainerRef = useRef<HTMLDivElement>(null);

  // Current iframe path (for sections editor)
  const [currentPath, setCurrentPath] = useState("/");

  // vmMap[userId][branch] -> { vmId, previewUrl, runnerKind? }
  const userId = session?.user?.id;
  const metadata = inset?.entity?.metadata;
  const vmEntry =
    userId && branch ? metadata?.vmMap?.[userId]?.[branch] : undefined;
  const previewUrl = vmEntry?.previewUrl ?? null;

  // Decofile pages for the URL bar dropdown
  const { data: decofile } = useDecofile(previewUrl);
  const pages = decofile ? extractPages(decofile) : [];

  // "reload" fires on config edits framework HMR won't catch (.ts/.tsx use HMR).
  const vmEvents = useVmEvents();
  useVmReloadHandler(() => {
    const iframe = previewIframeRef.current;
    if (!iframe) return;
    // biome-ignore lint/correctness/noSelfAssign: reloads the iframe
    // oxlint-disable-next-line no-self-assign
    iframe.src = iframe.src;
  });
  // `running` lifecycle phase carries the live port + htmlSupport flag;
  // `crashed` means the dev server stopped responding after coming up.
  // Everything else maps to "booting" for the preview overlay.
  //
  // htmlSupport only lives on the `running` event — but we need it to be
  // sticky across `running` → `crashed` so a transient drop doesn't flip a
  // working preview to the "No web page" empty state. Latch the last seen
  // value, keyed on previewUrl so a new VM resets it.
  const lifecyclePhase = vmEvents.lifecycle.phase;
  const htmlSupportRef = useRef<{ url: string; value: boolean }>({
    url: "",
    value: false,
  });
  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- TODO: refactor render-time .current access
  if (previewUrl && htmlSupportRef.current.url !== previewUrl) {
    // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- TODO: refactor render-time .current access
    htmlSupportRef.current = { url: previewUrl, value: false };
  }
  if (vmEvents.lifecycle.phase === "running") {
    // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- TODO: refactor render-time .current access
    htmlSupportRef.current.value = vmEvents.lifecycle.htmlSupport;
  }
  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- TODO: refactor render-time .current access
  const hasHtmlPreview = htmlSupportRef.current.value;
  const upstreamStatus: "booting" | "online" | "offline" =
    lifecyclePhase === "running"
      ? "online"
      : lifecyclePhase === "crashed"
        ? "offline"
        : "booting";
  const suspended = vmEvents.suspended;

  // Only the user-pause state routes to the suspended overlay (resume
  // affordance). The daemon's `error` state means the dev script crashed
  // — that's a failure, surfaced via the booting overlay's retry button
  // (gated on `lifecycle.phase ∈ {clone-failed, install-failed, start-failed,
  // crashed}`). Lumping the two would route every dev-script crash to the
  // resume UI, which has no retry path.
  const appPaused = vmEvents.status.state === "paused";

  // One mutation, two triggers. Dedup differs by meaning:
  //   auto-start: once per taskId
  //   self-heal:  once per dead vmId (don't loop on repeat 404s; new vmId OK)
  // A shared ref would conflate them.
  const virtualMcpId = inset?.entity?.id ?? null;
  const { org } = useProjectContext();
  const mcpClient = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: inset?.entity?.organization_id ?? "",
    orgSlug: org.slug,
  });
  const startVm = useVmStart(mcpClient);
  const lastStartError = startVm.error?.message ?? null;
  const vmStartPending = useIsVmStartPending(
    virtualMcpId ?? undefined,
    branch ?? undefined,
  );
  const autoStartedForTaskRef = useRef<string | null>(null);
  const reprovisionedForVmIdRef = useRef<string | null>(null);

  const claimPhase = vmEvents.phase;

  const progress = derivePhaseProgress({
    claimPhase,
    lifecycle: vmEvents.lifecycle,
  });

  const userStopped =
    !!virtualMcpId && !!branch && vmUserStop.isStopped(virtualMcpId, branch);

  const previewState = computePreviewState({
    previewUrl,
    status: upstreamStatus,
    htmlSupport: hasHtmlPreview,
    suspended,
    appPaused,
    vmStartPending,
    lastStartError,
    claimPhase,
    notFound: vmEvents.notFound,
    userStopped,
  });

  // ref-latest pattern: effects below depend only on upstream signals, not
  // on this closure's churning captures (branch, mutation, setter).
  const triggerStart = (reason: "auto-start" | "self-heal") => {
    if (!virtualMcpId) return;
    const args: VmStartArgs = { virtualMcpId };
    if (branch) args.branch = branch;
    startVm.mutate(args, {
      onSuccess: (data) => {
        // Server-generated branch: persist so later renders resolve via vmMap.
        if (data?.branch && !branch) setCurrentTaskBranch(data.branch);
      },
      onError: (err) => {
        console.error(`[preview] ${reason} VM_START failed`, err);
      },
    });
  };
  const triggerStartRef = useRef(triggerStart);
  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- TODO: refactor render-time .current access
  triggerStartRef.current = triggerStart;

  // Auto-start = "arrive → provision one", NOT "always ensure exists". Once
  // a vmEntry is seen for this taskId, explicit stop must NOT re-trigger (or
  // it races the user's manual Start). Mark ref on first-sight, BEFORE
  // evaluating shouldAutoStart, so a transient null can't sneak through.
  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- TODO: refactor render-time .current access
  if (taskId && vmEntry && autoStartedForTaskRef.current !== taskId) {
    // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- TODO: refactor render-time .current access
    autoStartedForTaskRef.current = taskId;
  }
  // Branch must be resolved before firing: VmEventsBridge keys auto-start on
  // `currentBranch`, and `useVmStart` dedupes by (virtualMcpId, branch).
  // Firing here with branch=null uses a different dedup key AND asks the
  // server to generate a fresh branch — that's a different sandbox than the
  // one the page is actually on.
  // Respect explicit user-stop across component remounts — the module-level `userStoppedVms` flag survives remounts but `autoStartedForTaskRef` resets, so without this gate a navigate-away-and-back would resurrect the killed VM.
  const shouldAutoStart =
    !!taskId &&
    !!virtualMcpId &&
    !!userId &&
    !!branch &&
    !vmEntry &&
    !lastStartError &&
    !userStopped &&
    !startVm.isPending &&
    // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- TODO: refactor render-time .current access
    autoStartedForTaskRef.current !== taskId;
  // oxlint-disable-next-line ban-use-effect/ban-use-effect — bridges external state (vmEntry derived from query cache, taskId from router) into a one-shot mutation; no render-time equivalent
  useEffect(() => {
    if (!shouldAutoStart || !taskId) return;
    autoStartedForTaskRef.current = taskId;
    triggerStartRef.current("auto-start");
  }, [shouldAutoStart, taskId, userStopped]);

  // Self-heal stale vmMap entries (SSE 404 → notFound). Dedup by dead vmId.
  const deadVmId = vmEvents.notFound ? (vmEntry?.vmId ?? null) : null;
  // oxlint-disable-next-line ban-use-effect/ban-use-effect — one-shot reprovision trigger gated on the notFound→deadVmId derivation
  useEffect(() => {
    if (!deadVmId || !virtualMcpId) return;
    if (lastStartError || startVm.isPending) return;
    if (reprovisionedForVmIdRef.current === deadVmId) return;
    // Don't self-heal a VM the user explicitly stopped: the SSE "gone" event
    // can arrive before the vmMap query refetch clears the stale entry.
    if (branch && vmUserStop.isStopped(virtualMcpId, branch)) return;
    reprovisionedForVmIdRef.current = deadVmId;
    triggerStartRef.current("self-heal");
  }, [deadVmId, virtualMcpId, lastStartError, startVm.isPending, branch]);

  const retryAutoStart = () => {
    autoStartedForTaskRef.current = null;
    reprovisionedForVmIdRef.current = null;
    startVm.reset();
    triggerStartRef.current("auto-start");
  };

  // Drawer state — open + height live here so state cards (Task 9) and the
  // "View logs" buttons can request the drawer to open.
  const queryClient = useQueryClient();
  const drawerStorageKey = virtualMcpId ?? "__no-vmcp__";
  // `null` = not yet hydrated for this VM. We hydrate (and re-hydrate on
  // VM switch) via a render-time setState gated by `lastHydratedKeyRef`,
  // so the stored value always tracks the *current* `drawerStorageKey`.
  // Without this, `useState`'s init callback would freeze the initial
  // key — if `virtualMcpId` was undefined at mount, the state would
  // forever reflect the `__no-vmcp__` slot. React bails on equal state,
  // and this is the idiomatic "derive state from a prop change" pattern
  // in this codebase (useEffect is banned for this).
  const [drawerOpen, setDrawerOpen] = useState<boolean | null>(null);
  const lastHydratedKeyRef = useRef<string | null>(null);
  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- TODO: refactor render-time .current access
  if (lastHydratedKeyRef.current !== drawerStorageKey) {
    // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- TODO: refactor render-time .current access
    lastHydratedKeyRef.current = drawerStorageKey;
    setDrawerOpen(readPersistedDrawerOpen(drawerStorageKey));
  }
  // Collapse to toolbar-only when the sandbox isn't running. Covers Stop
  // (transitions to never-started via vmUserStop) and the initial idle
  // state. Persisted preference is untouched so the drawer restores to
  // the user's last open/closed state once the sandbox boots again.
  // `null` (pre-hydration) is treated as closed so the drawer doesn't
  // flash open before the right key's value is read.
  const drawerOpenEffective =
    previewState.kind === "never-started" ? false : (drawerOpen ?? false);

  const handleDrawerOpenChange = (next: boolean) => {
    setDrawerOpen(next);
    writePersistedDrawerOpen(drawerStorageKey, next);
  };

  const openDrawer = () => handleDrawerOpenChange(true);

  // Stop / restart. VM_DELETE is best-effort; the vmMap query refetch is
  // what actually flips the UI to idle.
  const handleStop = async () => {
    if (!virtualMcpId) return;
    const branchToStop = branch;
    if (!branchToStop) return;
    vmUserStop.mark(virtualMcpId, branchToStop);
    try {
      await mcpClient.callTool({
        name: "VM_DELETE",
        arguments: { virtualMcpId, branch: branchToStop },
      });
    } catch {
      // Best effort
    }
    invalidateVirtualMcpQueries(queryClient);
  };

  const handleRestart = async () => {
    await handleStop();
    triggerStartRef.current("auto-start");
  };

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
      if (e.data?.type !== "visual-editor::element-clicked") return;
      const result = VisualEditorPayloadSchema.safeParse(e.data.payload);
      if (result.success) {
        setVisualElement(result.data);
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
      if (!pagesContainerRef.current?.contains(e.target as Node))
        setPagesOpen(false);
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

  const handleViewModeChange = (mode: PreviewViewMode) => {
    setViewMode(mode);
    setVisualElement(null);
    if (mode === "visual") {
      injectVisualEditor();
    } else {
      deactivateVisualEditor();
    }
  };

  const handleRefresh = () => {
    if (!previewIframeRef.current) return;
    const iframe = previewIframeRef.current;
    // biome-ignore lint/correctness/noSelfAssign: reloads the iframe
    // oxlint-disable-next-line no-self-assign
    iframe.src = iframe.src;
  };

  const handleHardReload = () => {
    if (!previewIframeRef.current || !previewUrl) return;
    const sep = previewUrl.includes("?") ? "&" : "?";
    previewIframeRef.current.src = `${previewUrl}${sep}_r=${Date.now()}`;
  };

  const handleCopyUrl = () => {
    const url =
      previewIframeRef.current?.contentWindow?.location?.href ?? previewUrl;
    if (url) navigator.clipboard.writeText(url);
  };

  const previewLabel = (() => {
    if (!previewUrl) return "No server running";
    try {
      const url = new URL(previewUrl);
      return `${url.host}${url.pathname === "/" ? "" : url.pathname}`;
    } catch {
      return previewUrl;
    }
  })();

  return (
    <div className="flex flex-col w-full h-full">
      {previewState.kind === "iframe" && (
        <div className="flex h-12 shrink-0 items-center gap-4 border-b border-border/60 px-3 md:px-4">
          {/* Group 1: view mode toggle + sections */}
          <div className="flex shrink-0 items-center gap-1">
            {hasHtmlPreview && (
              <ViewModeToggle
                value={viewMode}
                onValueChange={handleViewModeChange}
                options={VIEW_MODE_OPTIONS}
                size="sm"
                className="shrink-0 bg-foreground/4.5"
              />
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={sectionsOpen ? "secondary" : "ghost"}
                  size="icon"
                  onClick={() => setSectionsOpen((prev) => !prev)}
                >
                  <TextInput size={14} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Sections Editor</TooltipContent>
            </Tooltip>
          </div>

          {/* Group 2: nav + url */}
          <div className="flex min-w-0 flex-1 items-center gap-0.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() =>
                    previewIframeRef.current?.contentWindow?.history.back()
                  }
                >
                  <ArrowLeft size={14} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Back</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() =>
                    previewIframeRef.current?.contentWindow?.history.forward()
                  }
                >
                  <ArrowRight size={14} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Forward</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" onClick={handleRefresh}>
                  <RefreshCw01 size={14} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Refresh</TooltipContent>
            </Tooltip>

            <div ref={pagesContainerRef} className="relative min-w-0 flex-1">
              <button
                type="button"
                className="flex h-8 w-full min-w-0 items-center gap-1 rounded-md bg-background px-2 transition-colors duration-200 hover:bg-accent"
                onClick={() => setPagesOpen((prev) => !prev)}
              >
                <span className="min-w-0 flex-1 truncate text-left text-[12px] text-foreground/88">
                  {previewLabel}
                </span>
                {pages.length > 0 && (
                  <ChevronDown
                    size={12}
                    className={`shrink-0 text-muted-foreground transition-transform ${pagesOpen ? "rotate-180" : ""}`}
                  />
                )}
              </button>

              {pagesOpen && pages.length > 0 && (
                <div className="absolute left-0 right-0 top-full z-50 mt-1.5 overflow-hidden rounded-lg border bg-popover shadow-lg">
                  <ScrollArea className="max-h-80">
                    <div className="p-1.5">
                      {pages.map((page) => (
                        <button
                          key={page.key}
                          type="button"
                          className="flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
                          onClick={() => {
                            setPagesOpen(false);
                            setCurrentPath(page.path);
                            // Navigate the iframe
                            const iframe = previewIframeRef.current;
                            if (iframe && previewUrl) {
                              iframe.src = new URL(page.path, previewUrl).href;
                            }
                          }}
                        >
                          <span className="min-w-0 flex-1 truncate font-medium">
                            {page.name}
                          </span>
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {page.path}
                          </span>
                        </button>
                      ))}
                    </div>
                  </ScrollArea>
                </div>
              )}
            </div>
          </div>

          {/* Group 3: open in new tab + more actions */}
          <div className="flex shrink-0 items-center gap-0.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() =>
                    window.open(previewState.previewUrl, "_blank", "noopener")
                  }
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
        </div>
      )}

      <div className="flex-1 flex overflow-hidden">
        {/* Sections editor side panel (left) */}
        {sectionsOpen && previewUrl && branch && virtualMcpId && (
          <div className="w-96 shrink-0 border-r overflow-hidden">
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
                previewUrl={previewUrl}
                orgSlug={org.slug}
                virtualMcpId={virtualMcpId}
                branch={branch}
                currentPath={currentPath}
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
                      // Cross-origin fallback
                      // biome-ignore lint/correctness/noSelfAssign: reloads the iframe
                      // oxlint-disable-next-line no-self-assign
                      iframe.src = iframe.src;
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
        )}

        <div className="flex-1 relative overflow-hidden">
          {previewState.kind === "never-started" && (
            <div className="absolute inset-0 z-30">
              <VmStateCard
                kind="never-started"
                onStart={() => {
                  // Force the drawer closed so transitioning out of
                  // never-started doesn't unmask a persisted "open" preference
                  // and visually toggle the setup tab button.
                  handleDrawerOpenChange(false);
                  triggerStart("auto-start");
                }}
              />
            </div>
          )}

          {previewState.kind === "starting-now" && (
            <div className="absolute inset-0 z-30">
              <VmStateCard
                kind="starting-now"
                progress={progress}
                claimPhase={claimPhase}
              />
            </div>
          )}

          {previewState.kind === "errored" && (
            <div className="absolute inset-0 z-40">
              <VmStateCard
                kind="errored"
                progress={progress}
                logSource="setup"
                errorLine={
                  previewState.error.split("\n")[0] ?? "Failed to start"
                }
                onRetry={retryAutoStart}
                drawerOpen={drawerOpenEffective}
              />
            </div>
          )}

          {previewState.kind === "suspended" && (
            <div className="absolute inset-0 z-30">
              <VmStateCard kind="suspended" onResume={retryAutoStart} />
            </div>
          )}

          {previewState.kind === "crashed" && (
            <div className="absolute inset-0 z-30">
              <VmStateCard kind="crashed" onOpenTerminal={openDrawer} />
            </div>
          )}

          {previewState.kind === "no-html" && (
            <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-4 bg-background">
              <Server01 size={48} className="text-muted-foreground/40" />
              <h3 className="text-lg font-medium">No web page at this URL</h3>
              <p className="text-sm text-muted-foreground text-center max-w-sm">
                The server is running, but doesn't serve a web page at /. This
                preview only renders web pages.
              </p>
              <Button onClick={openDrawer}>
                <Server01 size={14} />
                View Logs
              </Button>
            </div>
          )}

          {viewMode === "visual" && !visualElement && (
            <div className="absolute top-2 left-1/2 -translate-x-1/2 z-20 flex items-center gap-1.5 rounded-full border border-violet-400/40 bg-violet-500/90 px-3 py-1 text-xs font-medium text-white shadow-md backdrop-blur-sm pointer-events-none select-none">
              <CursorClick01 size={12} />
              Click any element to ask the AI
            </div>
          )}
          {viewMode === "visual" && visualElement && (
            <VisualEditorPrompt
              element={visualElement}
              onDismiss={() => setVisualElement(null)}
            />
          )}
          {previewState.kind === "iframe" && (
            <iframe
              // Key on previewUrl: `src` mutations don't reliably refetch in all
              // browsers and leak in-frame state across branches.
              key={previewState.previewUrl}
              ref={previewIframeRef}
              src={previewState.previewUrl}
              className="w-full h-full border-0"
              title="Dev Server Preview"
              tabIndex={sectionsOpen ? -1 : undefined}
              onLoad={() => {
                // This is the VM dev-server preview (sandboxed running app),
                // NOT an MCP app. MCP apps render via <MCPAppRenderer/>.
                track("vm_preview_loaded", {
                  view_mode: viewMode,
                  vm_id: vmEntry?.vmId ?? null,
                  // Intentionally excluding the full previewUrl — it can contain
                  // ephemeral tokens / user data in the query string.
                });
                // Sync currentPath with the iframe's actual location so the
                // sections editor always reflects the displayed page.
                try {
                  const iframePath =
                    previewIframeRef.current?.contentWindow?.location?.pathname;
                  if (iframePath) setCurrentPath(iframePath);
                } catch {
                  // Cross-origin — can't read, keep current value
                }
                if (viewMode === "visual") {
                  injectVisualEditor();
                }
              }}
            />
          )}
        </div>
      </div>
      <PreviewDrawer
        // key forces a fresh drawer on each new VM so per-tab state
        // (active tab, scriptTabs, killingScripts, the auto-open ref)
        // resets cleanly without per-state reset plumbing.
        key={vmEntry?.vmId ?? "no-vm"}
        vmId={vmEntry?.vmId ?? null}
        orgSlug={org.slug}
        virtualMcpId={virtualMcpId}
        branch={branch}
        status={drawerStatusFromPreview(previewState, vmStartPending)}
        scripts={vmEvents.scripts}
        open={drawerOpenEffective}
        onOpenChange={handleDrawerOpenChange}
        onStart={() => triggerStart("auto-start")}
        onStop={handleStop}
        onRestart={handleRestart}
        onResume={retryAutoStart}
        onRetry={retryAutoStart}
      />
    </div>
  );
}
