import { useState, useRef, useEffect } from "react";
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
  CursorClick01,
  DotsHorizontal,
  LinkExternal01,
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
import { isRestartRequired } from "./restart-required";
import {
  PreviewDrawer,
  readPersistedDrawerOpen,
  writePersistedDrawerOpen,
} from "./drawer/drawer";
import type { DrawerStatus } from "./drawer/toolbar";
import { invalidateVirtualMcpQueries } from "@/web/lib/query-keys";
import { useQueryClient } from "@tanstack/react-query";
import { track } from "@/web/lib/posthog-client";

function drawerStatusFromPreview(
  state: PreviewState,
  vmStartPending: boolean,
): DrawerStatus {
  if (state.kind === "errored") return "errored";
  if (state.kind === "suspended") return "suspended";
  if (state.kind === "starting-now" || vmStartPending) return "starting";
  if (state.kind === "iframe" || state.kind === "no-html") return "running";
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

  // vmMap[userId][branch] -> { vmId, previewUrl, runnerKind? }
  const userId = session?.user?.id;
  const metadata = inset?.entity?.metadata;
  const vmEntry =
    userId && branch ? metadata?.vmMap?.[userId]?.[branch] : undefined;
  const previewUrl = vmEntry?.previewUrl ?? null;

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
  if (previewUrl && htmlSupportRef.current.url !== previewUrl) {
    htmlSupportRef.current = { url: previewUrl, value: false };
  }
  if (vmEvents.lifecycle.phase === "running") {
    htmlSupportRef.current.value = vmEvents.lifecycle.htmlSupport;
  }
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

  // Restart-required strip: surfaces when Settings has saved a
  // `metadata.runtime.selected` that differs from the value the running
  // daemon was started with (`vmEntry.startedWith.packageManager`). Only shows
  // while the VM is actually running so we don't nag during boot/error/idle.
  const liveSelected = metadata?.runtime?.selected ?? null;
  const isRunning =
    previewState.kind === "iframe" || previewState.kind === "no-html";
  const restartRequired = isRestartRequired({
    liveSelected,
    startedPackageManager: vmEntry?.startedWith?.packageManager,
    hasEntry: !!vmEntry,
    isRunning,
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
  triggerStartRef.current = triggerStart;

  // Auto-start = "arrive → provision one", NOT "always ensure exists". Once
  // a vmEntry is seen for this taskId, explicit stop must NOT re-trigger (or
  // it races the user's manual Start). Mark ref on first-sight, BEFORE
  // evaluating shouldAutoStart, so a transient null can't sneak through.
  if (taskId && vmEntry && autoStartedForTaskRef.current !== taskId) {
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
  const [drawerOpen, setDrawerOpen] = useState(() =>
    readPersistedDrawerOpen(drawerStorageKey),
  );

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
      {restartRequired && (
        <div className="flex h-9 shrink-0 items-center justify-between gap-3 border-b border-amber-500/40 bg-amber-500/10 px-4 text-xs">
          <span className="text-amber-700">
            ⓘ Settings changed — restart to apply
          </span>
          <Button size="sm" onClick={handleRestart}>
            <RefreshCw01 className="size-3.5" /> Restart now
          </Button>
        </div>
      )}
      {previewState.kind === "iframe" && (
        <div className="flex h-12 shrink-0 items-center gap-4 border-b border-border/60 px-3 md:px-4">
          {/* Group 1: view mode toggle */}
          {hasHtmlPreview && (
            <ViewModeToggle
              value={viewMode}
              onValueChange={handleViewModeChange}
              options={VIEW_MODE_OPTIONS}
              size="sm"
              className="shrink-0 bg-foreground/[0.045]"
            />
          )}

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

            <div className="flex h-8 min-w-0 flex-1 items-center rounded-md bg-background px-2 transition-colors duration-200 hover:bg-accent">
              <span className="min-w-0 flex-1 truncate text-[12px] text-foreground/88">
                {previewLabel}
              </span>
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

      <div className="flex-1 relative overflow-hidden">
        {previewState.kind === "never-started" && (
          <div className="absolute inset-0 z-30">
            <VmStateCard
              kind="never-started"
              onStart={() => triggerStart("auto-start")}
            />
          </div>
        )}

        {previewState.kind === "starting-now" && (
          <div className="absolute inset-0 z-30">
            <VmStateCard
              kind="starting-now"
              progress={progress}
              claimPhase={claimPhase}
              logSource="setup"
              onExpandLogs={openDrawer}
              drawerOpen={drawerOpen}
            />
          </div>
        )}

        {previewState.kind === "errored" && (
          <div className="absolute inset-0 z-40">
            <VmStateCard
              kind="errored"
              progress={progress}
              logSource="setup"
              errorLine={previewState.error.split("\n")[0] ?? "Failed to start"}
              onRetry={retryAutoStart}
              onExpandLogs={openDrawer}
              drawerOpen={drawerOpen}
            />
          </div>
        )}

        {previewState.kind === "suspended" && (
          <div className="absolute inset-0 z-30">
            <VmStateCard kind="suspended" onResume={retryAutoStart} />
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
            onLoad={() => {
              // This is the VM dev-server preview (sandboxed running app),
              // NOT an MCP app. MCP apps render via <MCPAppRenderer/>.
              track("vm_preview_loaded", {
                view_mode: viewMode,
                vm_id: vmEntry?.vmId ?? null,
                // Intentionally excluding the full previewUrl — it can contain
                // ephemeral tokens / user data in the query string.
              });
              if (viewMode === "visual") {
                injectVisualEditor();
              }
            }}
          />
        )}
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
        open={drawerOpen}
        onOpenChange={handleDrawerOpenChange}
        onStart={() => triggerStart("auto-start")}
        onStop={handleStop}
        onRestart={handleRestart}
        onResume={retryAutoStart}
        onRetry={retryAutoStart}
      />
      {/* TODO(task-12): auto-open the drawer when previewState transitions
          into "errored". Doing this without useEffect requires a render-time
          ref dance that risks stale state on rapid transitions; users can
          click "View logs" on the error state card in the meantime. */}
    </div>
  );
}
