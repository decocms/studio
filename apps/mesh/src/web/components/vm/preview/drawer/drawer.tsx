import { useState } from "react";
import { DrawerHeader, type DrawerStatus } from "./header";
import { DrawerTabs } from "./tabs";
import type { PhaseKey, PhaseProgress } from "../derive-phase-progress";

export interface PreviewDrawerProps {
  vmId: string | null;
  orgSlug: string;
  status: DrawerStatus;
  progress: PhaseProgress;
  scripts: string[];
  open: boolean;
  onOpenChange: (next: boolean) => void;
  onStart: () => void;
  onStop: () => void;
  onRestart: () => void;
  onResume: () => void;
}

export function PreviewDrawer(props: PreviewDrawerProps) {
  const [active, setActive] = useState<string>("setup");
  const [customTabs, setCustomTabs] = useState<string[]>([]);

  const handleToggle = () => props.onOpenChange(!props.open);

  const handlePhaseClick = (key: PhaseKey) => {
    if (key === "provision") return;
    props.onOpenChange(true);
    // cloning + install both map to the daemon's `setup` xterm stream;
    // dev maps to `dev`.
    setActive(key === "dev" ? "dev" : "setup");
  };

  const handleRunScript = async (name: string) => {
    setCustomTabs((prev) => (prev.includes(name) ? prev : [...prev, name]));
    setActive(name);
    props.onOpenChange(true);
    await fetch(
      `/api/${encodeURIComponent(props.orgSlug)}/vm-exec/exec/${encodeURIComponent(name)}`,
      { method: "POST" },
    );
  };

  const handleCloseScript = async (name: string) => {
    await fetch(
      `/api/${encodeURIComponent(props.orgSlug)}/vm-exec/kill/${encodeURIComponent(name)}`,
      { method: "POST" },
    );
    setCustomTabs((prev) => prev.filter((t) => t !== name));
    if (active === name) setActive("setup");
  };

  // Binary open/closed state — drawer either fills its tab-strip + xterm
  // body (50% of the preview area, set by the parent flex layout) or
  // collapses to just the header. No drag, no maximize.
  return (
    <div
      className="flex shrink-0 flex-col"
      style={{ height: props.open ? "50%" : "auto" }}
    >
      <DrawerHeader
        status={props.status}
        open={props.open}
        progress={props.progress}
        onToggle={handleToggle}
        onStart={props.status === "idle" ? props.onStart : undefined}
        onStop={
          props.status === "running" || props.status === "starting"
            ? props.onStop
            : undefined
        }
        onRestart={props.status === "running" ? props.onRestart : undefined}
        onResume={props.status === "suspended" ? props.onResume : undefined}
        onPhaseClick={handlePhaseClick}
      />
      {props.open && (
        <div className="flex flex-1 flex-col overflow-hidden">
          <DrawerTabs
            scripts={props.scripts}
            active={active}
            customTabs={customTabs}
            onSelect={setActive}
            onRunScript={handleRunScript}
            onCloseScript={handleCloseScript}
            vmId={props.vmId}
          />
        </div>
      )}
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
