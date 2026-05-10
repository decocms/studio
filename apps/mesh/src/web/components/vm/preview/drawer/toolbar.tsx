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
import { ChevronDown, ChevronUp, Plus, X } from "@untitledui/icons";
import { type DrawerStatus, statusPillFor } from "./status-pill";
import { menuItemsFor, type MenuItem } from "./toolbar-menu-items";

export type { DrawerStatus } from "./status-pill";

export interface DrawerToolbarProps {
  status: DrawerStatus;
  open: boolean;
  onToggle: () => void;
  onStart?: () => void;
  onStop?: () => void;
  onRestart?: () => void;
  onResume?: () => void;
  onRetry?: () => void;
  scripts: string[];
  active: string;
  customTabs: string[];
  onSelectTab: (tab: string) => void;
  onRunScript: (name: string) => void;
  onCloseScript: (name: string) => void;
}

const DEFAULT_TABS = ["setup", "dev"] as const;

export function DrawerToolbar(props: DrawerToolbarProps) {
  return (
    <div className="flex h-9 shrink-0 items-center gap-3 border-t border-border bg-muted/30 px-3">
      <StatusButton
        status={props.status}
        onStart={props.onStart}
        onStop={props.onStop}
        onRestart={props.onRestart}
        onResume={props.onResume}
        onRetry={props.onRetry}
      />
      <ToggleChevron open={props.open} onToggle={props.onToggle} />
      <TabStrip
        active={props.active}
        customTabs={props.customTabs}
        onSelectTab={props.onSelectTab}
        onCloseScript={props.onCloseScript}
      />
      <AddScriptButton scripts={props.scripts} onRun={props.onRunScript} />
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
  const handlerFor = (
    action: MenuItem["action"],
  ): (() => void) | undefined => {
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

function TabStrip({
  active,
  customTabs,
  onSelectTab,
  onCloseScript,
}: {
  active: string;
  customTabs: string[];
  onSelectTab: (tab: string) => void;
  onCloseScript: (name: string) => void;
}) {
  return (
    <div className="flex flex-1 min-w-0 items-center gap-1 overflow-x-auto">
      {DEFAULT_TABS.map((t) => (
        <TabButton
          key={t}
          active={active === t}
          onClick={() => onSelectTab(t)}
        >
          {t}
        </TabButton>
      ))}
      {customTabs.map((t) => (
        <TabButton
          key={t}
          active={active === t}
          onClick={() => onSelectTab(t)}
          onClose={() => onCloseScript(t)}
        >
          {t}
        </TabButton>
      ))}
    </div>
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
          "rounded-md px-2.5 py-1 text-xs",
          active
            ? "bg-background font-medium"
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
      <PopoverContent align="end" className="p-1 w-56">
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
