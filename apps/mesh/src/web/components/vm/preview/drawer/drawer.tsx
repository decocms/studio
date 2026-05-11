import { useRef, useState } from "react";
import { Play } from "@untitledui/icons";
import { useVmEvents } from "../../hooks/use-vm-events";
import { DEFAULT_TAB, DrawerToolbar, type DrawerStatus } from "./toolbar";
import { VmTerminal } from "./terminal";

const WELL_KNOWN_STARTERS = ["dev", "start"];

export interface PreviewDrawerProps {
  vmId: string | null;
  orgSlug: string;
  virtualMcpId: string | null;
  branch: string | null;
  status: DrawerStatus;
  scripts: string[];
  open: boolean;
  onOpenChange: (next: boolean) => void;
  onStart: () => void;
  onStop: () => void;
  onRestart: () => void;
  onResume: () => void;
  onRetry: () => void;
}

export function PreviewDrawer(props: PreviewDrawerProps) {
  const vmEvents = useVmEvents();
  const [active, setActive] = useState<string>(DEFAULT_TAB);
  const [scriptTabs, setScriptTabs] = useState<string[]>([]);
  const [killingScripts, setKillingScripts] = useState<Set<string>>(new Set());

  // Once-per-VM auto-open of dev/start. Render-time setState gated by a ref
  // so a second render after the first scripts event becomes a no-op. The
  // ref also persists across user-close: if the user closes the auto-opened
  // tab, we don't reopen it on the next render. Reset happens via the
  // `key={vmId}` remount at the call site (preview.tsx).
  const scriptsAppliedRef = useRef(false);
  if (!scriptsAppliedRef.current && vmEvents.scripts.length > 0) {
    const starter = WELL_KNOWN_STARTERS.find((s) =>
      vmEvents.scripts.includes(s),
    );
    if (starter) {
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

  // Mesh's vm-exec route requires virtualMcpId+branch to compute the
  // per-user claim handle (same shape as vm-events). Without them the
  // request 400s before reaching the daemon.
  const execScript = (name: string) => {
    if (!props.virtualMcpId || !props.branch) return Promise.resolve(null);
    const qs =
      `?virtualMcpId=${encodeURIComponent(props.virtualMcpId)}` +
      `&branch=${encodeURIComponent(props.branch)}`;
    return fetch(
      `/api/${encodeURIComponent(props.orgSlug)}/vm-exec/exec/${encodeURIComponent(name)}${qs}`,
      { method: "POST" },
    );
  };

  const killScript = (name: string) => {
    if (!props.virtualMcpId || !props.branch) return Promise.resolve(null);
    const qs =
      `?virtualMcpId=${encodeURIComponent(props.virtualMcpId)}` +
      `&branch=${encodeURIComponent(props.branch)}`;
    return fetch(
      `/api/${encodeURIComponent(props.orgSlug)}/vm-exec/kill/${encodeURIComponent(name)}${qs}`,
      { method: "POST" },
    );
  };

  const handleAddScript = async (name: string) => {
    setScriptTabs((prev) => (prev.includes(name) ? prev : [...prev, name]));
    setActive(name);
    props.onOpenChange(true);
    await execScript(name);
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
    await execScript(active);
  };

  // Per-script Stop on the active tab. Marks the script as killing so the
  // toolbar shows "Stopping…"; the prune above clears it once SSE confirms.
  const handleStopActive = async () => {
    if (killingScripts.has(active)) return;
    setKillingScripts((prev) => new Set(prev).add(active));
    try {
      const res = await killScript(active);
      if (!res || !res.ok)
        throw new Error(`Kill failed: ${res?.statusText ?? "no VM"}`);
    } catch {
      setKillingScripts((prev) => {
        const next = new Set(prev);
        next.delete(active);
        return next;
      });
    }
  };

  const isScriptTab = active !== DEFAULT_TAB && scriptTabs.includes(active);
  const scriptIsRunning =
    isScriptTab && vmEvents.activeProcesses.includes(active);
  const scriptIsKilling = isScriptTab && killingScripts.has(active);

  return (
    <div
      className="flex shrink-0 flex-col"
      style={{ height: props.open ? "50%" : "auto" }}
    >
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
  // When the sandbox isn't running, the preview area's never-started card
  // owns the single empty-state CTA. Rendering anything here (xterm shell
  // or "no output" copy) would compete with it.
  if (!vmId) return null;
  if (active === DEFAULT_TAB || hasData) {
    return <VmTerminal key={active} source={active} className="h-full" />;
  }
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
      <p>
        Script "<span className="font-mono text-foreground">{active}</span>" not
        running
      </p>
      <button
        type="button"
        onClick={onRunActive}
        className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs text-foreground hover:bg-accent"
      >
        <Play className="size-3.5" /> Run
      </button>
    </div>
  );
}

const STORAGE_KEY = (id: string) => `preview-drawer:${id}`;

export function readPersistedDrawerOpen(virtualMcpId: string): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY(virtualMcpId));
    if (!raw) return false;
    const p = JSON.parse(raw);
    return !!p.open;
  } catch {
    return false;
  }
}

export function writePersistedDrawerOpen(
  virtualMcpId: string,
  open: boolean,
): void {
  try {
    localStorage.setItem(STORAGE_KEY(virtualMcpId), JSON.stringify({ open }));
  } catch {
    /* ignore */
  }
}
