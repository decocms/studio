import { buildSandboxUrl } from "@/sdk/sandbox-url";
import { useOptionalChatTask } from "@/components/chat/chat-context";
import { WELL_KNOWN_STARTERS } from "@decocms/sandbox/shared";
import { useLayoutEffect, useRef, useState } from "react";
import { Play } from "@untitledui/icons";
import { toast } from "sonner";
import { useT } from "@/i18n/use-t.ts";
import { useSandboxEvents } from "../../hooks/use-sandbox-events";
import { DEFAULT_TAB, DrawerToolbar, type DrawerStatus } from "./toolbar";
import { SandboxTerminal } from "./terminal";
import {
  clampDrawerHeight,
  drawerHeightForKey,
  DRAWER_MIN_HEIGHT,
  DRAWER_TOP_RESERVE,
  resolveDrawerResizeMetrics,
} from "./resize";

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
    setScriptTabs((prev) => (prev.includes(name) ? prev : [...prev, name]));
    setActive(name);
    props.onOpenChange(true);
    await runExec(name, t("sandbox.drawer.failedToRun", { name }));
  };

  // × on a script tab: kill the process AND drop the tab. Active tab
  // falls back to setup.
  const handleCloseScript = async (name: string) => {
    await killScript(name);
    setScriptTabs((prev) => prev.filter((t) => t !== name));
    if (active === name) setActive(DEFAULT_TAB);
  };

  // Per-script Run/Restart on the active tab — does NOT add or remove the
  // tab; just (re)starts the process. Restart is the same call as Run; the
  // daemon's task-manager replaces the existing task with the same logName.
  const handleRunActive = async () => {
    const wasRunning = vmEvents.activeProcesses.includes(active);
    const failureMessage = wasRunning
      ? t("sandbox.drawer.failedToRestart", { name: active })
      : t("sandbox.drawer.failedToRun", { name: active });
    await runExec(active, failureMessage);
  };

  // Per-script Stop on the active tab. Marks the script as killing so the
  // toolbar shows "Stopping…"; the prune above clears it once SSE confirms.
  const handleStopActive = async () => {
    if (killingScripts.has(active)) return;
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

  // The ARIA range needs the live pane bound, which CSS alone cannot expose.
  // Observe only the parent pane—not the drawer—so pointer dragging remains an
  // imperative, render-free path while window/layout resizes stay accurate.
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
      const paneHeight = pane.getBoundingClientRect().height;
      const next = resolveDrawerResizeMetrics(
        drawer.getBoundingClientRect().height,
        paneHeight,
      );
      setResizeMetrics((current) =>
        current?.height === next.height && current.maxHeight === next.maxHeight
          ? current
          : next,
      );
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(pane);
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
      className="flex shrink-0 flex-col"
      style={{
        height: props.open ? (props.height ?? "50%") : "auto",
        minHeight: props.open ? DRAWER_MIN_HEIGHT : undefined,
        // Cap relative to the pane so a persisted px height from a taller
        // window can never swallow the tab body above when the window shrinks.
        // `max(MIN, …)` keeps the same floor as `clampDrawerHeight` so a pane
        // shorter than the reserve can't collapse the drawer past the min.
        maxHeight: props.open
          ? `max(${DRAWER_MIN_HEIGHT}px, calc(100% - ${DRAWER_TOP_RESERVE}px))`
          : undefined,
      }}
    >
      {props.open && resizeMetrics && (
        <ResizeHandle
          onPointerDown={handleResizeStart}
          onKeyDown={handleResizeKeyDown}
          label={t("sandbox.preview.resizeTerminal")}
          value={resizeMetrics.height}
          max={resizeMetrics.maxHeight}
        />
      )}
      <DrawerToolbar
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
        onSelectTab={handleSelectTab}
        onAddScript={handleAddScript}
        onCloseScript={handleCloseScript}
        showScriptControls={isScriptTab}
        scriptIsRunning={scriptIsRunning}
        scriptIsKilling={scriptIsKilling}
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
}: {
  vmId: string | null;
  active: string;
  hasData: boolean;
  onRunActive: () => void;
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
        onClick={onRunActive}
        className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs text-foreground hover:bg-accent"
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
  max,
}: {
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  label: string;
  value: number;
  max: number;
}) {
  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation="horizontal"
      aria-label={label}
      aria-valuemin={DRAWER_MIN_HEIGHT}
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
