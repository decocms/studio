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
  ChevronUp,
  Loading01,
  Play,
  Plus,
  RefreshCw01,
  Terminal,
  X,
} from "@untitledui/icons";
import { useT } from "@/web/i18n/use-t.ts";
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
  const t = useT();
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
    <div className="flex h-7 shrink-0 items-center gap-1 border-t border-b border-border bg-muted/60 px-2">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={props.onToggle}
            aria-label={props.open ? "Collapse terminal" : "Expand terminal"}
            aria-expanded={props.open}
            className="size-6 shrink-0"
          >
            {props.open ? (
              <ChevronDown className="size-4" />
            ) : (
              <ChevronUp className="size-4" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {props.open ? "Collapse terminal" : "Expand terminal"}
        </TooltipContent>
      </Tooltip>
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        <SetupTab
          active={props.active === DEFAULT_TAB}
          open={props.open}
          onClick={handleSetupClick}
          t={t}
        />
        {props.scriptTabs.map((tabName) => (
          <TabButton
            key={tabName}
            active={props.active === tabName}
            onClick={() => {
              if (props.active === tabName) props.onToggle();
              else props.onSelectTab(tabName);
            }}
            onClose={() => props.onCloseScript(tabName)}
            t={t}
          >
            {tabName}
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
          t={t}
        />
      ) : (
        <SandboxActionControls
          status={props.status}
          onStart={props.onStart}
          onStop={props.onStop}
          onRestart={props.onRestart}
          onResume={props.onResume}
          onRetry={props.onRetry}
          t={t}
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
  t,
}: {
  active: boolean;
  open: boolean;
  onClick: () => void;
  t: import("@/web/i18n/use-t.ts").TFunction;
}) {
  return (
    <button
      type="button"
      aria-pressed={active && open}
      aria-expanded={active && open}
      onClick={onClick}
      className={cn(
        "flex h-6 items-center gap-1.5 rounded-md border px-2 text-xs",
        active
          ? "border-border bg-background font-medium text-foreground shadow-sm"
          : "border-transparent text-muted-foreground hover:bg-background/50 hover:text-foreground",
      )}
    >
      <Terminal className="size-4" />
      {t("sandbox.toolbar.setupTab")}
    </button>
  );
}

/**
 * Right-side sandbox lifecycle controls. One control surface for every
 * non-script status:
 *   - idle      → [▶ Start]
 *   - suspended → [▶ Resume]
 *   - errored   → [↻ Retry]
 *   - starting  → [Stop]
 *   - running   → [Stop]  +  chevron menu { Restart }
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
  t,
}: {
  status: DrawerStatus;
  onStart?: () => void;
  onStop?: () => void;
  onRestart?: () => void;
  onResume?: () => void;
  onRetry?: () => void;
  t: import("@/web/i18n/use-t.ts").TFunction;
}) {
  if (status === "idle" && onStart) {
    return (
      <Button variant="outline" size="xs" onClick={onStart}>
        <Play className="size-3.5" /> {t("sandbox.toolbar.start")}
      </Button>
    );
  }
  if (status === "suspended" && onResume) {
    return (
      <Button variant="outline" size="xs" onClick={onResume}>
        <Play className="size-3.5" /> {t("sandbox.toolbar.resume")}
      </Button>
    );
  }
  if (status === "errored" && onRetry) {
    return (
      <Button variant="outline" size="xs" onClick={onRetry}>
        <RefreshCw01 className="size-3.5" /> {t("sandbox.toolbar.retry")}
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
              size="xs"
              onClick={onStop}
              className={cn(
                showRestart ? "rounded-r-none border-r-0" : undefined,
              )}
            >
              {t("sandbox.toolbar.stop")}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {t("sandbox.toolbar.stopSandboxTooltip")}
          </TooltipContent>
        </Tooltip>
        {showRestart && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="xs"
                className="rounded-l-none px-1"
              >
                <ChevronDown className="size-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={onRestart}>
                <RefreshCw01 className="size-3.5" />{" "}
                {t("sandbox.toolbar.restart")}
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
  t,
}: {
  active: boolean;
  onClick: () => void;
  onClose?: () => void;
  children: React.ReactNode;
  t: import("@/web/i18n/use-t.ts").TFunction;
}) {
  return (
    <div
      className={cn(
        "flex h-6 items-center rounded-md border text-xs",
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
          onClose ? "pl-2 pr-1" : "px-2",
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
          aria-label={t("sandbox.toolbar.closeTab", { tab: String(children) })}
          onClick={onClose}
          className="pr-1.5 text-muted-foreground hover:text-foreground"
        >
          <X className="size-3.5" />
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
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="xs"
              aria-label={t("sandbox.toolbar.runScript")}
            >
              <Plus className="size-4" />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{t("sandbox.toolbar.runScript")}</TooltipContent>
      </Tooltip>
      <PopoverContent align="start" className="p-1 w-56">
        <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
          {t("sandbox.toolbar.runAScript")}
        </div>
        {scripts.length === 0 ? (
          <div className="px-2 py-2 text-xs text-muted-foreground">
            {t("sandbox.toolbar.noScriptsFound")}
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
  t,
}: {
  isRunning: boolean;
  isKilling: boolean;
  onRun: () => void;
  onStop: () => void;
  t: import("@/web/i18n/use-t.ts").TFunction;
}) {
  if (isKilling) {
    return (
      <Button variant="outline" size="xs" disabled>
        <Loading01 className="size-3.5 animate-spin" />{" "}
        {t("sandbox.toolbar.stopping")}
      </Button>
    );
  }
  if (!isRunning) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="outline" size="xs" onClick={onRun}>
            <Play className="size-3.5" /> {t("sandbox.toolbar.run")}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t("sandbox.toolbar.startProcess")}</TooltipContent>
      </Tooltip>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="outline" size="xs" onClick={onStop}>
          {t("sandbox.toolbar.stop")}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{t("sandbox.toolbar.stopProcess")}</TooltipContent>
    </Tooltip>
  );
}
