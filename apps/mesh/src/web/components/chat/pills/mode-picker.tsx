import { useState } from "react";
import { Button } from "@deco/ui/components/button.tsx";
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
import { Check, ChevronDown, Cloud01 } from "@untitledui/icons";
import {
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  useProjectContext,
} from "@decocms/mesh-sdk";
import { useCurrentLink } from "@/web/hooks/use-current-link";
import { useSandboxStart } from "@/web/components/sandbox/hooks/use-sandbox-start";
import { track } from "@/web/lib/posthog-client";
import { ClaudeCodeIcon, CodexIcon } from "../agent-icons";
import type { PillPriority } from "../pill-priority";
import {
  type AgentMode,
  useAgentMode,
  useSetAgentMode,
} from "../use-agent-mode";

export interface ModePickerAvailability {
  claudeCode: boolean;
  codex: boolean;
}

interface PureProps {
  mode: AgentMode;
  availability: ModePickerAvailability;
  locked: boolean;
  /** Container-query priority for the closed-pill label / chevron. */
  priority?: PillPriority;
  onSelect: (mode: AgentMode) => void;
}

interface ModeRow {
  mode: AgentMode;
  label: string;
  description: string;
  group: "cloud" | "local";
  icon: React.ReactNode;
  isAvailable: (a: ModePickerAvailability) => boolean;
}

const ROW_DECOPILOT: ModeRow = {
  mode: "cloud-decopilot",
  label: "Decopilot",
  description: "Runs on the cloud",
  group: "cloud",
  icon: <Cloud01 size={16} />,
  isAvailable: () => true,
};

const ROW_CLAUDE_CODE: ModeRow = {
  mode: "local-claude-code",
  label: "Claude Code",
  description: "Runs via Claude Code CLI",
  group: "local",
  icon: <ClaudeCodeIcon size={16} />,
  isAvailable: (a) => a.claudeCode,
};

const ROW_CODEX: ModeRow = {
  mode: "local-codex",
  label: "Codex",
  description: "Runs via Codex CLI",
  group: "local",
  icon: <CodexIcon size={16} />,
  isAvailable: (a) => a.codex,
};

function pillLabel(mode: AgentMode): { icon: React.ReactNode; text: string } {
  if (mode === "local-claude-code")
    return { icon: <ClaudeCodeIcon size={14} />, text: "Claude Code" };
  if (mode === "local-codex")
    return { icon: <CodexIcon size={14} />, text: "Codex" };
  return { icon: <Cloud01 size={14} />, text: "Cloud" };
}

const baseClasses =
  "text-muted-foreground hover:text-foreground text-xs transition-[gap] duration-200";
const localActiveClasses = "text-success hover:text-success";

/**
 * Pure variant — no external dependencies (no context, no queries, no MCP
 * client). Owns only local UI state (the popover open flag) so tests can
 * mount it without mocking the chat context. Renders the closed pill +
 * the popover with three sectioned rows.
 */
export function ModePickerPure({
  mode,
  availability,
  locked,
  priority = "primary",
  onSelect,
}: PureProps) {
  const [open, setOpen] = useState(false);
  const { icon, text } = pillLabel(mode);
  const isLocal = mode !== "cloud-decopilot";

  const handleSelect = (m: AgentMode) => {
    onSelect(m);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={locked ? undefined : setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="default"
                aria-label={text}
                disabled={locked}
                className={cn(
                  baseClasses,
                  isLocal && localActiveClasses,
                  priority === "secondary"
                    ? "gap-0 @[628px]/chat-bottom:gap-1.5"
                    : "gap-0 @[320px]/chat-bottom:gap-1.5",
                )}
              >
                {icon}
                <span
                  className={cn(
                    "inline-block overflow-hidden whitespace-nowrap transition-[max-width,opacity] duration-200 ease-out max-w-0 opacity-0",
                    priority === "secondary"
                      ? "@[628px]/chat-bottom:max-w-32 @[628px]/chat-bottom:opacity-100"
                      : "@[320px]/chat-bottom:max-w-32 @[320px]/chat-bottom:opacity-100",
                  )}
                >
                  {text}
                </span>
                <ChevronDown
                  size={12}
                  className={cn(
                    "opacity-60 hidden",
                    priority === "secondary"
                      ? "@[628px]/chat-bottom:inline-block"
                      : "@[320px]/chat-bottom:inline-block",
                  )}
                />
              </Button>
            </PopoverTrigger>
          </span>
        </TooltipTrigger>
        <TooltipContent>{text}</TooltipContent>
      </Tooltip>
      <PopoverContent align="start" className="p-1 w-64">
        <div role="menu" className="flex flex-col">
          <Section title="Cloud" />
          <Row
            row={ROW_DECOPILOT}
            active={mode === ROW_DECOPILOT.mode}
            available={ROW_DECOPILOT.isAvailable(availability)}
            onSelect={handleSelect}
          />
          <Section title="Local" />
          <Row
            row={ROW_CLAUDE_CODE}
            active={mode === ROW_CLAUDE_CODE.mode}
            available={ROW_CLAUDE_CODE.isAvailable(availability)}
            onSelect={handleSelect}
          />
          <Row
            row={ROW_CODEX}
            active={mode === ROW_CODEX.mode}
            available={ROW_CODEX.isAvailable(availability)}
            onSelect={handleSelect}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}

function Section({ title }: { title: string }) {
  return (
    <div className="px-2 pt-2 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
      {title}
    </div>
  );
}

function Row({
  row,
  active,
  available,
  onSelect,
}: {
  row: ModeRow;
  active: boolean;
  available: boolean;
  onSelect: (mode: AgentMode) => void;
}) {
  const description = available ? row.description : "Not connected";
  return (
    <button
      type="button"
      role="menuitem"
      data-available={available}
      onClick={() => onSelect(row.mode)}
      className={cn(
        "flex items-start gap-2 px-2 py-1.5 rounded-md text-left",
        "hover:bg-muted",
        !available && "opacity-60",
      )}
    >
      <span className="shrink-0 text-muted-foreground mt-0.5">{row.icon}</span>
      <div className="flex-1">
        <div className="text-sm">{row.label}</div>
        <div className="text-xs text-muted-foreground">{description}</div>
      </div>
      {active && <Check size={14} className="text-foreground mt-0.5" />}
    </button>
  );
}

interface SmartProps {
  locked: boolean;
  currentBranch: string | null;
  virtualMcpId: string;
  priority?: PillPriority;
}

/**
 * Smart wrapper used by `ChatModeRow`. Reads agent-mode + link
 * capabilities, writes via `useSetAgentMode`, and fires the eager VM
 * start for local modes when a branch is present.
 */
export function ModePicker({
  locked,
  currentBranch,
  virtualMcpId,
  priority = "primary",
}: SmartProps) {
  const mode = useAgentMode();
  const setAgentMode = useSetAgentMode();
  const link = useCurrentLink();
  const { org } = useProjectContext();
  const mcpClient = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });
  const startVm = useSandboxStart(mcpClient);

  const availability: ModePickerAvailability = {
    claudeCode: link.online && link.capabilities.includes("claude-code"),
    codex: link.online && link.capabilities.includes("codex"),
  };

  const handleSelect = (next: AgentMode) => {
    setAgentMode(next);
    track("agent_mode_selected", { mode: next });
    if (next !== "cloud-decopilot" && currentBranch) {
      startVm.mutate({
        virtualMcpId,
        branch: currentBranch,
        sandboxProviderKind: "user-desktop" as const,
      });
    }
  };

  return (
    <ModePickerPure
      mode={mode}
      availability={availability}
      locked={locked}
      priority={priority}
      onSelect={handleSelect}
    />
  );
}
