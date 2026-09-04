import { buildSandboxUrl } from "@/sdk/sandbox-url";
import { useOptionalChatTask } from "@/components/chat/chat-context";
import { WELL_KNOWN_STARTERS } from "@decocms/sandbox/shared";
import { useLayoutEffect, useRef, useState } from "react";
import { Play } from "@untitledui/icons";
import { toast } from "sonner";
import { useT } from "@/i18n/use-t.ts";
import { useSandboxEvents } from "../../hooks/use-sandbox-events";
import {
  DEFAULT_TAB,
  DrawerToolbar,
  type DrawerStatus,
  type DrawerToolbarHandle,
} from "./toolbar";
import { SandboxTerminal } from "./terminal";
import {
  clampDrawerHeight,
  drawerHeightForKey,
  resolveDrawerResizeMetrics,
} from "./resize";
import { activeTabAfterScriptClose } from "./script-tab-state";

export interface PreviewDrawerProps {
  vmId: string | null;
  orgSlug: string;
  virtualMcpId: string | null;
  branch: string | null;
  status: DrawerStatus;
  scripts: string[];
  open: boolean;
  onOpenChange: (next: boolean) => void;
  /** Persisted open-drawer height in px; `null` falls back to 50% of the pane. */
  height: number | null;
  onHeightChange: (height: number) => void;
  onStart: () => void;
  onStop: () => void;
  onRestart: () => void;
  onResume: () => void;
  onRetry: () => void;
}

export function PreviewDrawer(props: PreviewDrawerProps) {
  const t = useT();
  const vmEvents = useSandboxEvents();
  const [active, setActive] = useState<string>(DEFAULT_TAB);
  const [scriptTabs, setScriptTabs] = useState<string[]>([]);
  const [killingScripts, setKillingScripts] = useState<Set<string>>(new Set());
  const [closingScriptTabs, setClosingScriptTabs] = useState<Set<string>>(
    new Set(),
  );
  const closingScriptTabsRef = useRef<Map<string, number>>(new Map());
  const scriptTabVersionsRef = useRef<Map<string, number>>(new Map());
  const toolbarRef = useRef<DrawerToolbarHandle>(null);
  const activeTabRef = useRef(DEFAULT_TAB);

  // Once-per-VM auto-open of dev/start. Render-time setState gated by a ref
  // so a second render after the first scripts event becomes a no-op. The
  // ref also persists across user-close: if the user closes the auto-opened
  // tab, we don't reopen it on the next render. Reset happens via the
  // `key={vmId}` remount at the call site (preview.tsx).
  const scriptsAppliedRef = useRef(false);
  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- TODO: refactor render-time .current access
  if (!scriptsAppliedRef.current && vmEvents.scripts.length > 0) {
    const starter = WELL_KNOWN_STARTERS.find((s) =>
      vmEvents.scripts.includes(s),
    );
    if (starter) {
      // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- TODO: refactor render-time .current access
      scriptsAppliedRef.current = true;
      // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- active event-state mirror for delayed close completions
      activeTabRef.current = starter;
      setScriptTabs((prev) =>
        prev.includes(starter) ? prev : [...prev, starter],
      );
      setActive(starter);
    }
  }

  // Prune killingScripts once SSE confirms the process stopped — drives
  // the transient "Stopping…" affordance back to "Run". Render-time
  // setState is fine: React bails when the next set is equal.
  if (killingScripts.size > 0) {
    let changed = false;
    const next = new Set(killingScripts);
    for (const name of killingScripts) {
      if (!vmEvents.activeProcesses.includes(name)) {
        next.delete(name);
        changed = true;
      }
    }
    if (changed) setKillingScripts(next);
  }

  const handleToggle = () => props.onOpenChange(!props.open);

  // Tab click also opens the drawer when collapsed. Once open, subsequent
  // tab clicks just switch tabs.
  const handleSelectTab = (tab: string) => {
    activeTabRef.current = tab;
    setActive(tab);
    if (!props.open) props.onOpenChange(true);
  };

  // Studio's sandbox proxy route requires virtualMcpId+branch in the path to
  // compute the per-user claim handle. Without them the request 400s
  // before reaching the daemon.
  const taskId = useOptionalChatTask()?.taskId ?? null;
  const execRef = {
    orgSlug: props.orgSlug,
    virtualMcpId: props.virtualMcpId ?? "",
    branch: props.branch ?? "",
    threadId: taskId ?? null,
  };

  const execScript = (name: string) => {
    if (!props.virtualMcpId || !props.branch) return Promise.resolve(null);
    return fetch(buildSandboxUrl(execRef, `exec/${encodeURIComponent(name)}`), {
      method: "POST",
    });
  };

  const killScript = (name: string) => {
    if (!props.virtualMcpId || !props.branch) return Promise.resolve(null);
    return fetch(
      buildSandboxUrl(execRef, `exec/${encodeURIComponent(name)}/kill`),
      { method: "POST" },
    );
  };

  const runExec = async (name: string, failureMessage: string) => {
    try {
      const res = await execScript(name);
      // res === null means missing virtualMcpId/branch — programming error,
      // not a user-facing failure. Skip the toast.
      if (res === null) return;
      if (!res.ok) throw new Error(`Exec failed: ${res.statusText}`);
    } catch {
      toast.error(failureMessage);
    }
  };

  const handleAddScript = async (name: string) => {
    // A same-name tab opened after an older close request is a new incarnation.
    // That older response may stop its own process, but must never remove this
    // newer UI handle.
    scriptTabVersionsRef.current.set(
      name,
      (scriptTabVersionsRef.current.get(name) ?? 0) + 1,
    );
    setScriptTabs((prev) => (prev.includes(name) ? prev : [...prev, name]));
    activeTabRef.current = name;
    setActive(name);
    props.onOpenChange(true);
    await runExec(name, t("sandbox.drawer.failedToRun", { name }));
  };

  // × on a script tab: kill the process AND drop the tab only once the
  // daemon confirms the kill. The functional active-state update is important:
  // a user may select another tab while this request is in flight.
  const handleCloseScript = async (
    name: string,
    closeButton: HTMLButtonElement,
  ) => {
    // State disables the control on the next commit; the ref closes the smaller
    // same-tick gap where two events can enter before that commit. Check before
    // installing focus-intent listeners so a rejected duplicate owns nothing.
    if (closingScriptTabsRef.current.has(name)) return;
    const version = scriptTabVersionsRef.current.get(name) ?? 0;
    closingScriptTabsRef.current.set(name, version);
    const closeOwnedFocus = document.activeElement === closeButton;
    let focusHandoffCancelled = false;
    const cancelForPointerIntent = (event: PointerEvent) => {
      if (event.target !== closeButton) focusHandoffCancelled = true;
    };
    const cancelForKeyboardIntent = (event: KeyboardEvent) => {
      if (event.key === "Tab" || document.activeElement !== closeButton) {
        focusHandoffCancelled = true;
      }
    };
    if (closeOwnedFocus) {
      document.addEventListener("pointerdown", cancelForPointerIntent, true);
      document.addEventListener("keydown", cancelForKeyboardIntent, true);
    }
    setClosingScriptTabs((prev) => new Set(prev).add(name));
    try {
      const res = await killScript(name);
      // Missing sandbox identity is a programming/setup state. Keep the tab so
      // the user does not lose the only handle for retrying once it is ready.
      if (res === null) return;
      if (!res.ok) throw new Error(`Kill failed: ${res.statusText}`);
      if ((scriptTabVersionsRef.current.get(name) ?? 0) !== version) return;
      const shouldRestoreFocus = closeOwnedFocus && !focusHandoffCancelled;
      scriptTabVersionsRef.current.set(name, version + 1);
      setScriptTabs((prev) => prev.filter((tab) => tab !== name));
      const focusTarget = activeTabAfterScriptClose(
        activeTabRef.current,
        name,
        DEFAULT_TAB,
      );
      activeTabRef.current = focusTarget;
      setActive((current) =>
        activeTabAfterScriptClose(current, name, DEFAULT_TAB),
      );
      if (shouldRestoreFocus) {
        // Browser focus fallout from removing the active control finishes after
        // the commit. Focus the surviving active tab on the following frame.
        // `shouldRestoreFocus` was captured before removal, so an intermediate
        // browser fallback (often the add-script trigger) is not user intent.
        requestAnimationFrame(() => {
          toolbarRef.current?.focusTab(focusTarget);
        });
      }
    } catch {
      toast.error(t("sandbox.drawer.failedToStop", { name }));
    } finally {
      document.removeEventListener("pointerdown", cancelForPointerIntent, true);
      document.removeEventListener("keydown", cancelForKeyboardIntent, true);
      if (closingScriptTabsRef.current.get(name) === version) {
        closingScriptTabsRef.current.delete(name);
        setClosingScriptTabs((prev) => {
          const next = new Set(prev);
          next.delete(name);
          return next;
        });
      }
    }
  };

  // Per-script Run/Restart on the active tab — does NOT add or remove the
  // tab; just (re)starts the process. Restart is the same call as Run; the
  // daemon's task-manager replaces the existing task with the same logName.
  const handleRunActive = async () => {
    if (closingScriptTabsRef.current.has(active)) return;
    const wasRunning = vmEvents.activeProcesses.includes(active);
    const failureMessage = wasRunning
      ? t("sandbox.drawer.failedToRestart", { name: active })
      : t("sandbox.drawer.failedToRun", { name: active });
    await runExec(active, failureMessage);
  };

  // Per-script Stop on the active tab. Marks the script as killing so the
  // toolbar shows "Stopping…"; the prune above clears it once SSE confirms.
  const handleStopActive = async () => {
    if (
      killingScripts.has(active) ||
      closingScriptTabsRef.current.has(active)
    ) {
      return;
    }
    setKillingScripts((prev) => new Set(prev).add(active));
    try {
      const res = await killScript(active);
      // res === null means missing virtualMcpId/branch — programming error,
      // not a user-facing failure. Skip the toast (but still revert UI).
      if (res === null) {
        setKillingScripts((prev) => {
          const next = new Set(prev);
          next.delete(active);
          return next;
        });
        return;
      }
      if (!res.ok) throw new Error(`Kill failed: ${res.statusText}`);
    } catch {
      setKillingScripts((prev) => {
        const next = new Set(prev);
        next.delete(active);
        return next;
      });
      toast.error(t("sandbox.drawer.failedToStop", { name: active }));
    }
  };

  const isScriptTab = active !== DEFAULT_TAB && scriptTabs.includes(active);
  const scriptIsRunning =
    isScriptTab && vmEvents.activeProcesses.includes(active);
  const scriptIsKilling = isScriptTab && killingScripts.has(active);
  const scriptClosePending = isScriptTab && closingScriptTabs.has(active);

  // Drag-to-resize the open drawer. The height is applied imperatively to the
  // drawer element during the drag (no per-frame React render, so the xterm
  // refit stays smooth) and committed to persisted state on pointer-up. We
  // don't reuse `react-resizable-panels` (ResizablePanelGroup in preview.tsx)
  // here: that governs a horizontal split *inside* the tab body, whereas this
  // drawer is a sibling below it whose "closed" state is a fixed-height,
  // always-interactive toolbar — and the lib's controlled re-render per drag
  // frame would fight the imperative height write above. Pointer capture binds
  // the whole gesture to the handle, so pointerup/pointercancel are delivered
  // even when the cursor leaves the window (no sticky drag / stuck body cursor).
  const drawerRef = useRef<HTMLDivElement>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const [resizeMetrics, setResizeMetrics] = useState<{
    height: number;
    minHeight: number;
    maxHeight: number;
  } | null>(null);

  // A route change can unmount the Site Editor in the middle of a captured
  // pointer gesture. The detached handle will not reliably receive pointerup,
  // so release document-wide interaction styles and listeners explicitly.
  useLayoutEffect(
    () => () => {
      resizeCleanupRef.current?.();
    },
    [],
  );

  // CSS and the ARIA separator share one live range. Observe the pane for new
  // bounds and the drawer for the clamped rendered value; pointer dragging
  // remains render-free because resize callbacks are ignored during a gesture.
  useLayoutEffect(() => {
    if (!props.open) {
      resizeCleanupRef.current?.();
      setResizeMetrics(null);
      return;
    }

    const drawer = drawerRef.current;
    const pane = drawer?.parentElement;
    if (!drawer || !pane) return;

    const measure = () => {
      if (resizeCleanupRef.current) return;
      const paneHeight = pane.getBoundingClientRect().height;
      const next = resolveDrawerResizeMetrics(
        drawer.getBoundingClientRect().height,
        paneHeight,
      );
      setResizeMetrics((current) =>
        current?.height === next.height &&
        current.minHeight === next.minHeight &&
        current.maxHeight === next.maxHeight
          ? current
          : next,
      );
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(pane);
    observer.observe(drawer);
    return () => observer.disconnect();
  }, [props.open, props.height]);

  const handleResizeStart = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!props.open || !e.isPrimary || e.button !== 0) return;
    const el = drawerRef.current;
    const pane = el?.parentElement;
    if (!el || !pane) return;
    resizeCleanupRef.current?.();
    e.preventDefault();
    const handle = e.currentTarget;
    const { pointerId } = e;
    handle.setPointerCapture(pointerId);
    const startY = e.clientY;
    const startHeight = el.getBoundingClientRect().height;
    const paneHeight = pane.getBoundingClientRect().height;
    let nextHeight = startHeight;
    const previousBodyUserSelect = document.body.style.userSelect;
    const previousBodyCursor = document.body.style.cursor;
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      // Dragging up (smaller clientY) grows the drawer; clamp so it stays
      // usable and never swallows the tab body above it.
      nextHeight = clampDrawerHeight(
        startHeight + (startY - ev.clientY),
        paneHeight,
      );
      el.style.height = `${nextHeight}px`;
    };
    const cleanup = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", finish);
      handle.removeEventListener("pointercancel", finish);
      handle.removeEventListener("lostpointercapture", finish);
      if (handle.hasPointerCapture(pointerId)) {
        handle.releasePointerCapture(pointerId);
      }
      document.body.style.userSelect = previousBodyUserSelect;
      document.body.style.cursor = previousBodyCursor;
      if (resizeCleanupRef.current === cleanup) {
        resizeCleanupRef.current = null;
      }
    };
    const finish = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      cleanup();
      setResizeMetrics(resolveDrawerResizeMetrics(nextHeight, paneHeight));
      props.onHeightChange(nextHeight);
    };
    document.body.style.userSelect = "none";
    document.body.style.cursor = "row-resize";
    resizeCleanupRef.current = cleanup;
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", finish);
    handle.addEventListener("pointercancel", finish);
    handle.addEventListener("lostpointercapture", finish);
  };

  const handleResizeKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const drawer = drawerRef.current;
    const pane = drawer?.parentElement;
    if (!drawer || !pane) return;

    const paneHeight = pane.getBoundingClientRect().height;
    const nextHeight = drawerHeightForKey(
      e.key,
      drawer.getBoundingClientRect().height,
      paneHeight,
    );
    if (nextHeight === null) return;

    e.preventDefault();
    drawer.style.height = `${nextHeight}px`;
    setResizeMetrics(resolveDrawerResizeMetrics(nextHeight, paneHeight));
    props.onHeightChange(nextHeight);
  };

  return (
    <div
      ref={drawerRef}
      className="flex shrink-0 flex-col overflow-hidden"
      style={{
        height: props.open ? (props.height ?? "50%") : "auto",
        minHeight:
          props.open && resizeMetrics
            ? `${resizeMetrics.minHeight}px`
            : undefined,
        maxHeight:
          props.open && resizeMetrics
            ? `${resizeMetrics.maxHeight}px`
            : undefined,
      }}
    >
      {props.open && resizeMetrics && (
        <ResizeHandle
          onPointerDown={handleResizeStart}
          onKeyDown={handleResizeKeyDown}
          label={t("sandbox.preview.resizeTerminal")}
          value={resizeMetrics.height}
          min={resizeMetrics.minHeight}
          max={resizeMetrics.maxHeight}
        />
      )}
      <DrawerToolbar
        ref={toolbarRef}
        status={props.status}
        open={props.open}
        onToggle={handleToggle}
        onStart={props.status === "idle" ? props.onStart : undefined}
        onStop={
          props.status === "running" || props.status === "starting"
            ? props.onStop
            : undefined
        }
        onRestart={props.status === "running" ? props.onRestart : undefined}
        onResume={props.status === "suspended" ? props.onResume : undefined}
        onRetry={props.status === "errored" ? props.onRetry : undefined}
        scripts={props.scripts}
        active={active}
        scriptTabs={scriptTabs}
        closingScriptTabs={closingScriptTabs}
        onSelectTab={handleSelectTab}
        onAddScript={handleAddScript}
        onCloseScript={handleCloseScript}
        showScriptControls={isScriptTab}
        scriptIsRunning={scriptIsRunning}
        scriptIsKilling={scriptIsKilling || scriptClosePending}
        onRunActiveScript={handleRunActive}
        onStopActiveScript={handleStopActive}
      />
      {props.open && (
        <div className="flex-1 overflow-hidden">
          <DrawerBody
            vmId={props.vmId}
            active={active}
            hasData={vmEvents.hasData(active)}
            onRunActive={handleRunActive}
            runDisabled={scriptClosePending}
          />
        </div>
      )}
    </div>
  );
}

/**
 * Single xterm instance, key-remounted on tab change. Force-remount fixes
 * a stale-content bug in `terminal.tsx`: its mount-only effect captures
 * the initial `source` to replay the buffer once, then never re-replays —
 * so swapping the source prop on a mounted xterm leaves the previous
 * source's content visible while new chunks for the new source append on
 * top. Remounting per `active` gives each tab a fresh xterm with the
 * correct buffer replay.
 *
 * Empty-state branch: setup always renders an xterm (it's the catch-all
 * for clone + install logs). A script tab without a buffer and not running
 * shows a "Click Run" affordance instead.
 */
function DrawerBody({
  vmId,
  active,
  hasData,
  onRunActive,
  runDisabled,
}: {
  vmId: string | null;
  active: string;
  hasData: boolean;
  onRunActive: () => void;
  runDisabled: boolean;
}) {
  const t = useT();
  // When the sandbox isn't running, the preview area shows a starting card
  // (or suspended card) that owns the single empty-state CTA. Rendering
  // anything here (xterm shell or "no output" copy) would compete with it.
  if (!vmId) return null;
  if (active === DEFAULT_TAB || hasData) {
    return <SandboxTerminal key={active} source={active} className="h-full" />;
  }
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
      <p>{t("sandbox.drawer.scriptNotRunning", { name: active })}</p>
      <button
        type="button"
        disabled={runDisabled}
        onClick={onRunActive}
        className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs text-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Play className="size-3.5" /> {t("sandbox.drawer.run")}
      </button>
    </div>
  );
}

/**
 * Drag strip along the drawer's top edge. Sits flush over the toolbar's top
 * border (`-mb-px`) so the divider becomes the resize affordance: at rest it's
 * the toolbar border; on hover the line highlights and the cursor turns into
 * `row-resize`. The actual resize math lives in `PreviewDrawer.handleResizeStart`.
 *
 * It is also an ARIA range separator: ArrowUp/ArrowDown resize by one step and
 * Home/End move to the bounds. The live px range mirrors pointer clamping.
 */
function ResizeHandle({
  onPointerDown,
  onKeyDown,
  label,
  value,
  min,
  max,
}: {
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  label: string;
  value: number;
  min: number;
  max: number;
}) {
  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation="horizontal"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      className="group relative -mb-px h-1.5 shrink-0 touch-none cursor-row-resize select-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary"
    >
      <div className="absolute inset-x-0 bottom-0 h-px bg-transparent transition-colors group-hover:bg-primary" />
    </div>
  );
}
