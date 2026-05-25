import { useState } from "react";
import { Button } from "@deco/ui/components/button.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@deco/ui/components/popover.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { Check, ChevronDown, Cloud01, Monitor01 } from "@untitledui/icons";
import {
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  useProjectContext,
} from "@decocms/mesh-sdk";
import { useCurrentLink } from "@/web/hooks/use-current-link";
import { useSandboxStart } from "@/web/components/sandbox/hooks/use-sandbox-start";
import { track } from "@/web/lib/posthog-client";
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
  onSelect: (mode: AgentMode) => void;
}

interface ModeRow {
  mode: AgentMode;
  label: string;
  group: "cloud" | "local";
  icon: React.ReactNode;
  isAvailable: (a: ModePickerAvailability) => boolean;
}

const ROW_DECOPILOT: ModeRow = {
  mode: "cloud-decopilot",
  label: "Decopilot",
  group: "cloud",
  icon: <Cloud01 size={14} />,
  isAvailable: () => true,
};

const ROW_CLAUDE_CODE: ModeRow = {
  mode: "local-claude-code",
  label: "Claude Code",
  group: "local",
  icon: <Monitor01 size={14} />,
  isAvailable: (a) => a.claudeCode,
};

const ROW_CODEX: ModeRow = {
  mode: "local-codex",
  label: "Codex",
  group: "local",
  icon: <Monitor01 size={14} />,
  isAvailable: (a) => a.codex,
};

function pillLabel(mode: AgentMode): { icon: React.ReactNode; text: string } {
  if (mode === "local-claude-code")
    return { icon: <Monitor01 size={14} />, text: "Claude Code" };
  if (mode === "local-codex")
    return { icon: <Monitor01 size={14} />, text: "Codex" };
  return { icon: <Cloud01 size={14} />, text: "Cloud" };
}

const baseClasses =
  "gap-1.5 text-muted-foreground hover:text-foreground text-xs";
const localActiveClasses = "text-success bg-success/10 hover:text-success";

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
  onSelect,
}: PureProps) {
  const [open, setOpen] = useState(false);
  const { icon, text } = pillLabel(mode);
  const isLocal = mode !== "cloud-decopilot";

  const handleSelect = (m: AgentMode) => {
    onSelect(m);
    setOpen(false);
  };

  if (locked) {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1.5 px-2 py-1 rounded-md border border-border bg-muted text-xs",
          isLocal ? "text-success" : "text-muted-foreground",
        )}
        title="Fixed for this thread"
      >
        {icon}
        {text}
      </span>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={text}
          className={cn(baseClasses, isLocal && localActiveClasses)}
        >
          {icon}
          <span>{text}</span>
          <ChevronDown size={12} className="opacity-60" />
        </Button>
      </PopoverTrigger>
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
  return (
    <button
      type="button"
      role="menuitem"
      data-available={available}
      onClick={() => onSelect(row.mode)}
      className={cn(
        "flex items-center gap-2 px-2 py-1.5 rounded-md text-sm text-left",
        "hover:bg-muted",
        !available && "opacity-60",
      )}
    >
      <span className="shrink-0">{row.icon}</span>
      <span className="flex-1">{row.label}</span>
      {!available && (
        <span className="text-xs text-muted-foreground">Not connected</span>
      )}
      {active && <Check size={14} className="text-foreground" />}
    </button>
  );
}

interface SmartProps {
  locked: boolean;
  currentBranch: string | null;
  virtualMcpId: string;
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
      onSelect={handleSelect}
    />
  );
}
