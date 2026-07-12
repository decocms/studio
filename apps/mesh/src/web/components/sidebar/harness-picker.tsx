import { useState } from "react";
import { cn } from "@deco/ui/lib/utils.ts";
import { Check } from "@untitledui/icons";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@deco/ui/components/popover.tsx";
import { getWellKnownDecopilotVirtualMCP } from "@decocms/mesh-sdk";
import { AgentAvatar } from "@/web/components/agent-icon";
import { ClaudeCodeIcon, CodexIcon } from "@/web/components/chat/agent-icons";
import { useAgentOptionAvailability } from "@/web/components/chat/use-agent-availability";
import {
  type AgentMode,
  useAgentMode,
  useSetAgentMode,
} from "@/web/components/chat/use-agent-mode";

const DECOPILOT_ICON = getWellKnownDecopilotVirtualMCP("").icon;

function activeHarnessKey(
  mode: AgentMode,
): "decopilot" | "claude-code" | "codex" {
  if (mode === "local-claude-code") return "claude-code";
  if (mode === "local-codex") return "codex";
  return "decopilot";
}

interface CircleDef {
  key: "decopilot" | "claude-code" | "codex";
  node: React.ReactNode;
}

const ALL_CIRCLES: CircleDef[] = [
  {
    key: "decopilot",
    node: (
      <AgentAvatar
        icon={DECOPILOT_ICON}
        name="Decopilot"
        size="2xs"
        className="size-4 rounded-full ring-2 ring-sidebar"
      />
    ),
  },
  {
    key: "claude-code",
    node: (
      <span className="size-4 rounded-full bg-[#c05621] flex items-center justify-center ring-2 ring-sidebar text-white shrink-0">
        <ClaudeCodeIcon size={10} />
      </span>
    ),
  },
  {
    key: "codex",
    node: (
      <span className="size-4 rounded-full bg-[#5561e8] flex items-center justify-center ring-2 ring-sidebar text-white shrink-0">
        <CodexIcon size={10} />
      </span>
    ),
  },
];

function StackedIcons({ mode }: { mode: AgentMode }) {
  const activeKey = activeHarnessKey(mode);
  const rest = ALL_CIRCLES.filter((c) => c.key !== activeKey);
  const active = ALL_CIRCLES.find((c) => c.key === activeKey)!;
  const ordered = [...rest, active];

  return (
    <span className="flex items-center shrink-0">
      {ordered.map((circle, i) => (
        <span key={circle.key} className={cn(i > 0 && "-ml-1.5")}>
          {circle.node}
        </span>
      ))}
    </span>
  );
}

function modeLabel(mode: AgentMode): string {
  return mode === "cloud-decopilot" ? "Cloud" : "Local";
}

interface RowDef {
  mode: AgentMode;
  label: string;
  description: string;
  icon: React.ReactNode;
  isAvailable: (a: ReturnType<typeof useAgentOptionAvailability>) => boolean;
}

const ROWS: RowDef[] = [
  {
    mode: "cloud-decopilot",
    label: "Decopilot",
    description: "Runs in an agent sandbox",
    icon: (
      <AgentAvatar
        icon={DECOPILOT_ICON}
        name="Decopilot"
        size="2xs"
        className="size-4 rounded-sm"
      />
    ),
    isAvailable: (a) => a.agentSandbox,
  },
  {
    mode: "local-decopilot",
    label: "Decopilot",
    description: "Runs on your desktop",
    icon: (
      <AgentAvatar
        icon={DECOPILOT_ICON}
        name="Decopilot"
        size="2xs"
        className="size-4 rounded-sm"
      />
    ),
    isAvailable: (a) => a.userDesktop,
  },
  {
    mode: "local-claude-code",
    label: "Claude Code",
    description: "Runs via Claude Code CLI",
    icon: <ClaudeCodeIcon size={16} />,
    isAvailable: (a) => a.userDesktop && a.claudeCode,
  },
  {
    mode: "local-codex",
    label: "Codex",
    description: "Runs via Codex CLI",
    icon: <CodexIcon size={16} />,
    isAvailable: (a) => a.userDesktop && a.codex,
  },
];

export function HarnessPicker({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const mode = useAgentMode();
  const setAgentMode = useSetAgentMode();
  const availability = useAgentOptionAvailability();

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Select agent runtime"
          className={cn(
            "wco-no-drag flex items-center gap-2 shrink-0 cursor-pointer",
            "hover:opacity-80 transition-opacity",
            className,
          )}
        >
          <StackedIcons mode={mode} />
          <span className="text-sm font-medium text-foreground">
            {modeLabel(mode)}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="p-1 w-64">
        <div role="menu" className="flex flex-col">
          {ROWS.map((row) => {
            const available = row.isAvailable(availability);
            return (
              <button
                key={row.mode}
                type="button"
                role="menuitem"
                onClick={() => {
                  setAgentMode(row.mode);
                  setOpen(false);
                }}
                className="flex items-start gap-2 px-2 py-1.5 rounded-md text-left hover:bg-muted"
              >
                <span className="shrink-0 text-muted-foreground mt-0.5">
                  {row.icon}
                </span>
                <div className="flex-1">
                  <div className="text-sm">{row.label}</div>
                  <div className="text-xs text-muted-foreground">
                    {available
                      ? row.description
                      : availability.userDesktop
                        ? "Not detected on your desktop"
                        : "Desktop not detected"}
                  </div>
                </div>
                {mode === row.mode && (
                  <Check size={14} className="text-foreground mt-0.5" />
                )}
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
