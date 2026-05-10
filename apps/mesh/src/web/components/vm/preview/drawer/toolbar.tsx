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
  StopCircle,
  X,
} from "@untitledui/icons";
import { type DrawerStatus, statusPillFor } from "./status-pill";
import { menuItemsFor, type MenuItem } from "./toolbar-menu-items";

/** The always-present tab. Catch-all for clone + install logs. */
export const DEFAULT_TAB = "setup";

export type { DrawerStatus } from "./status-pill";

export interface DrawerToolbarProps {
  status: DrawerStatus;
  open: boolean;
  onToggle: () => void;
  // VM lifecycle actions surfaced via the status split-button menu.
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

  return (
    <div className="flex h-9 shrink-0 items-center gap-3 border-t border-border bg-muted/60 px-3">
      <StatusButton
        status={props.status}
        onStart={props.onStart}
        onStop={props.onStop}
        onRestart={props.onRestart}
        onResume={props.onResume}
        onRetry={props.onRetry}
      />
      <ToggleChevron open={props.open} onToggle={props.onToggle} />
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        <TabButton
          active={props.active === DEFAULT_TAB}
          onClick={() => props.onSelectTab(DEFAULT_TAB)}
        >
          {DEFAULT_TAB}
        </TabButton>
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
      {props.showScriptControls && (
        <ScriptControls
          isRunning={props.scriptIsRunning}
          isKilling={props.scriptIsKilling}
          onRun={props.onRunActiveScript}
          onStop={props.onStopActiveScript}
        />
      )}
    </div>
  );
}

function StatusButton(
  props: { status: DrawerStatus } & Pick<
    DrawerToolbarProps,
    "onStart" | "onStop" | "onRestart" | "onResume" | "onRetry"
  >,
) {
  const { className, label } = statusPillFor(props.status);
  const items = menuItemsFor(props.status);
  const handlerFor = (action: MenuItem["action"]): (() => void) | undefined => {
    switch (action) {
      case "start":
        return props.onStart;
      case "stop":
        return props.onStop;
      case "restart":
        return props.onRestart;
      case "resume":
        return props.onResume;
      case "retry":
        return props.onRetry;
    }
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-haspopup="menu"
          className={cn(
            "flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide",
            className,
          )}
        >
          ● {label}
          <ChevronDown className="size-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {items.map((item) => {
          const handler = handlerFor(item.action);
          if (!handler) return null;
          return (
            <DropdownMenuItem key={item.action} onClick={handler}>
              {item.label}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ToggleChevron({
  open,
  onToggle,
}: {
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label="Toggle logs"
          aria-expanded={open}
          className="text-muted-foreground hover:text-foreground"
          onClick={onToggle}
        >
          {open ? (
            <ChevronDown className="size-3.5" />
          ) : (
            <ChevronUp className="size-3.5" />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent>{open ? "Hide logs" : "Show logs"}</TooltipContent>
    </Tooltip>
  );
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
    <div className="flex items-center">
      <button
        type="button"
        onClick={onClick}
        className={cn(
          "rounded-md border px-2.5 py-1 text-xs",
          active
            ? "border-border bg-background font-medium text-foreground shadow-sm"
            : "border-transparent text-muted-foreground hover:bg-background/50 hover:text-foreground",
        )}
      >
        {children}
      </button>
      {onClose && (
        <button
          type="button"
          aria-label={`Close ${children}`}
          onClick={onClose}
          className="ml-0.5 text-muted-foreground hover:text-foreground"
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

/**
 * Per-script Run / Restart / Stop controls. Renders only on a non-setup
 * active tab. Mirrors origin/main env.tsx semantics:
 *   - not running          → [▶ Run]
 *   - running, not killing → [↻ Restart]  +  chevron menu { Stop }
 *   - kill in flight       → [⏳ Stopping…] disabled
 */
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
      <Button variant="ghost" size="sm" disabled>
        <Loading01 className="size-3.5 animate-spin" /> Stopping…
      </Button>
    );
  }
  if (!isRunning) {
    return (
      <Button variant="ghost" size="sm" onClick={onRun}>
        <Play className="size-3.5" /> Run
      </Button>
    );
  }
  return (
    <div className="flex items-center">
      <Button
        variant="ghost"
        size="sm"
        onClick={onRun}
        className="rounded-r-none"
      >
        <RefreshCw01 className="size-3.5" /> Restart
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="rounded-l-none px-1">
            <ChevronDown className="size-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={onStop}>
            <StopCircle className="size-3.5" /> Stop
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
