import { useState } from "react";
import { DrawerToolbar, type DrawerStatus } from "./toolbar";
import { VmTerminal } from "./terminal";

export interface PreviewDrawerProps {
  vmId: string | null;
  orgSlug: string;
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
  const [active, setActive] = useState<string>("setup");
  const [customTabs, setCustomTabs] = useState<string[]>([]);

  const handleToggle = () => props.onOpenChange(!props.open);

  // Tab click also opens the drawer when collapsed (option A from the
  // spec). Once open, subsequent tab clicks just switch tabs.
  const handleSelectTab = (tab: string) => {
    setActive(tab);
    if (!props.open) props.onOpenChange(true);
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

  // Binary open/closed state — drawer either fills its toolbar + xterm
  // body (50% of the preview area, set by the parent flex layout) or
  // collapses to just the toolbar. No drag, no maximize.
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
        customTabs={customTabs}
        onSelectTab={handleSelectTab}
        onRunScript={handleRunScript}
        onCloseScript={handleCloseScript}
      />
      {props.open && (
        <div className="flex-1 overflow-hidden">
          {props.vmId ? (
            <VmTerminal source={active} className="h-full" />
          ) : (
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
              No output yet — start the dev server to begin
            </div>
          )}
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
