import { useState } from "react";
import { Button } from "@deco/ui/components/button.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@deco/ui/components/popover.tsx";
import { Plus, X } from "@untitledui/icons";
import { cn } from "@deco/ui/lib/utils.ts";
import { VmTerminal } from "./terminal";

export interface DrawerTabsProps {
  /** Discovered scripts (excluding well-known starters). */
  scripts: string[];
  /** Active tab id ("setup" | "dev" | <scriptName>). */
  active: string;
  /** User-spawned script tabs. */
  customTabs: string[];
  onSelect: (tab: string) => void;
  /** Opens a tab and starts the script. */
  onRunScript: (name: string) => void;
  /** Closes the tab and kills the process. */
  onCloseScript: (name: string) => void;
  /** Null when no VM (renders empty placeholder). */
  vmId: string | null;
}

const DEFAULT_TABS = ["setup", "dev"] as const;

export function DrawerTabs(props: DrawerTabsProps) {
  return (
    <div className="flex flex-1 flex-col">
      <div className="flex items-center gap-1 border-b border-border bg-muted/20 px-2">
        {DEFAULT_TABS.map((t) => (
          <TabButton
            key={t}
            active={props.active === t}
            onClick={() => props.onSelect(t)}
          >
            {t}
          </TabButton>
        ))}
        {props.customTabs.map((t) => (
          <TabButton
            key={t}
            active={props.active === t}
            onClick={() => props.onSelect(t)}
            onClose={() => props.onCloseScript(t)}
          >
            {t}
          </TabButton>
        ))}
        <RunScriptPopover scripts={props.scripts} onRun={props.onRunScript} />
      </div>
      <div className="flex-1 overflow-hidden">
        {props.vmId ? (
          <VmTerminal source={props.active} className="h-full" />
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            No output yet — start the dev server to begin
          </div>
        )}
      </div>
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

function RunScriptPopover({
  scripts,
  onRun,
}: {
  scripts: string[];
  onRun: (n: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="ml-auto">
          <Plus className="size-3.5" /> run script
        </Button>
      </PopoverTrigger>
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
