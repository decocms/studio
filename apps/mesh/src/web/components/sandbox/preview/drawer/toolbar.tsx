import { useState } from "react";
import { Button } from "@deco/ui/components/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@deco/ui/components/dropdown-menu.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@deco/ui/components/popover.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  ChevronDown,
  Loading01,
  Play,
  Plus,
  RefreshCw01,
  StopCircle,
  Terminal,
  X,
} from "@untitledui/icons";
import type { DrawerStatus } from "./status-pill";

/** The always-present tab. Catch-all for clone + install logs. */
export const DEFAULT_TAB = "setup";

export type { DrawerStatus } from "./status-pill";

export interface DrawerToolbarProps {
  status: DrawerStatus;
  open: boolean;
  onToggle: () => void;
  // VM lifecycle actions surfaced via the setup tab's split-button menu.
  onStart?: () => void;
  onStop?: () => void;
  onRestart?: () => void;
  onResume?: () => void;
  onRetry?: () => void;
  // Tab strip + add-script popover. `setup` is implicit; `scriptTabs` lists
  // every other open tab (auto-opened dev/start + popover-opened scripts).
  scripts: string[];
  active: string;
  scriptTabs: string[];
  onSelectTab: (tab: string) => void;
  onAddScript: (name: string) => void;
  onCloseScript: (name: string) => void;
  // Per-script controls on the right. Only render when the active tab is a
  // script tab (not setup); drawer.tsx owns the gating.
  showScriptControls: boolean;
  scriptIsRunning: boolean;
  scriptIsKilling: boolean;
  onRunActiveScript: () => void;
  onStopActiveScript: () => void;
}

export function DrawerToolbar(props: DrawerToolbarProps) {
  const addableScripts = props.scripts.filter(
    (s) => !props.scriptTabs.includes(s),
  );

  // The setup tab doubles as the drawer toggle. When already active, clicking
  // toggles open/closed; otherwise it selects setup (which opens the drawer).
  const handleSetupClick = () => {
    if (props.active === DEFAULT_TAB) props.onToggle();
    else props.onSelectTab(DEFAULT_TAB);
  };

  return (
    <div className="flex h-10 shrink-0 items-center gap-1 border-t border-b border-border bg-muted/60 px-3">
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        <SetupTab
          active={props.active === DEFAULT_TAB}
          open={props.open}
          onClick={handleSetupClick}
        />
        {props.scriptTabs.map((t) => (
          <TabButton
            key={t}
            active={props.active === t}
            onClick={() => props.onSelectTab(t)}
            onClose={() => props.onCloseScript(t)}
          >
            {t}
          </TabButton>
        ))}
        <AddScriptButton scripts={addableScripts} onRun={props.onAddScript} />
      </div>
      {props.showScriptControls ? (
        <ScriptControls
          isRunning={props.scriptIsRunning}
          isKilling={props.scriptIsKilling}
          onRun={props.onRunActiveScript}
          onStop={props.onStopActiveScript}
        />
      ) : (
        <SandboxActionControls
          status={props.status}
          onStart={props.onStart}
          onStop={props.onStop}
          onRestart={props.onRestart}
          onResume={props.onResume}
          onRetry={props.onRetry}
        />
      )}
    </div>
  );
}

/**
 * Setup tab + drawer toggle. Pure tab — sandbox lifecycle actions
 * (Start/Stop/Restart/Resume/Retry) all live on the right via
 * SandboxActionControls so the tab itself never reshapes based on status.
 */
function SetupTab({
  active,
  open,
  onClick,
}: {
  active: boolean;
  open: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active && open}
      aria-expanded={active && open}
      onClick={onClick}
      className={cn(
        "flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-xs",
        active
          ? "border-border bg-background font-medium text-foreground shadow-sm"
          : "border-transparent text-muted-foreground hover:bg-background/50 hover:text-foreground",
      )}
    >
      <Terminal className="size-3.5" />
      sandbox
    </button>
  );
}

/**
 * Right-side sandbox lifecycle controls. One control surface for every
 * non-script status:
 *   - idle      → [▶ Start]
 *   - suspended → [▶ Resume]
 *   - errored   → [↻ Retry]
 *   - starting  → [⏹ Stop]
 *   - running   → [⏹ Stop]  +  chevron menu { Restart }
 * Restarting a still-starting sandbox makes no sense, so the chevron half
 * only renders for "running".
 */
function SandboxActionControls({
  status,
  onStart,
  onStop,
  onRestart,
  onResume,
  onRetry,
}: {
  status: DrawerStatus;
  onStart?: () => void;
  onStop?: () => void;
  onRestart?: () => void;
  onResume?: () => void;
  onRetry?: () => void;
}) {
  if (status === "idle" && onStart) {
    return (
      <Button variant="outline" size="sm" onClick={onStart}>
        <Play className="size-3.5" /> Start
      </Button>
    );
  }
  if (status === "suspended" && onResume) {
    return (
      <Button variant="outline" size="sm" onClick={onResume}>
        <Play className="size-3.5" /> Resume
      </Button>
    );
  }
  if (status === "errored" && onRetry) {
    return (
      <Button variant="outline" size="sm" onClick={onRetry}>
        <RefreshCw01 className="size-3.5" /> Retry
      </Button>
    );
  }
  if (status === "starting" || status === "running") {
    const showRestart = status === "running" && !!onRestart;
    return (
      <div className="flex items-center">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              onClick={onStop}
              className={cn(
                showRestart ? "rounded-r-none border-r-0" : undefined,
              )}
            >
              <StopCircle className="size-3.5" /> Stop
            </Button>
          </TooltipTrigger>
          <TooltipContent>Stop sandbox</TooltipContent>
        </Tooltip>
        {showRestart && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="rounded-l-none px-1"
              >
                <ChevronDown className="size-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={onRestart}>
                <RefreshCw01 className="size-3.5" /> Restart
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    );
  }
  return null;
}

function TabButton({
  active,
  onClick,
  onClose,
  children,
}: {
  active: boolean;
  onClick: () => void;
  onClose?: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex h-7 items-center rounded-md border text-xs",
        active
          ? "border-border bg-background shadow-sm"
          : "border-transparent hover:bg-background/50",
      )}
    >
      <button
        type="button"
        onClick={onClick}
        className={cn(
          "flex h-full items-center",
          onClose ? "pl-2.5 pr-1" : "px-2.5",
          active
            ? "font-medium text-foreground"
            : "text-muted-foreground hover:text-foreground",
        )}
      >
        {children}
      </button>
      {onClose && (
        <button
          type="button"
          aria-label={`Close ${children}`}
          onClick={onClose}
          className="pr-1.5 text-muted-foreground hover:text-foreground"
        >
          <X className="size-3" />
        </button>
      )}
    </div>
  );
}

function AddScriptButton({
  scripts,
  onRun,
}: {
  scripts: string[];
  onRun: (n: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="sm" aria-label="Run script">
              <Plus className="size-3.5" />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>Run script</TooltipContent>
      </Tooltip>
      <PopoverContent align="start" className="p-1 w-56">
        <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
          run a script
        </div>
        {scripts.length === 0 ? (
          <div className="px-2 py-2 text-xs text-muted-foreground">
            No scripts found
          </div>
        ) : (
          scripts.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => {
                setOpen(false);
                onRun(s);
              }}
              className="w-full rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent"
            >
              ▸ {s}
            </button>
          ))
        )}
      </PopoverContent>
    </Popover>
  );
}

function ScriptControls({
  isRunning,
  isKilling,
  onRun,
  onStop,
}: {
  isRunning: boolean;
  isKilling: boolean;
  onRun: () => void;
  onStop: () => void;
}) {
  if (isKilling) {
    return (
      <Button variant="outline" size="sm" disabled>
        <Loading01 className="size-3.5 animate-spin" /> Stopping…
      </Button>
    );
  }
  if (!isRunning) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="outline" size="sm" onClick={onRun}>
            <Play className="size-3.5" /> Run
          </Button>
        </TooltipTrigger>
        <TooltipContent>Start process</TooltipContent>
      </Tooltip>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="outline" size="sm" onClick={onStop}>
          <StopCircle className="size-3.5" /> Stop
        </Button>
      </TooltipTrigger>
      <TooltipContent>Stop process</TooltipContent>
    </Tooltip>
  );
}
