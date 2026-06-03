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
import { Check, ChevronDown, Cloud01, Lock01 } from "@untitledui/icons";
import {
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  useProjectContext,
} from "@decocms/mesh-sdk";
import type { HarnessId } from "@/harnesses";
import { useCurrentLink } from "@/web/hooks/use-current-link";
import { useSandboxStart } from "@/web/components/sandbox/hooks/use-sandbox-start";
import { track } from "@/web/lib/posthog-client";
import { useOptionalChatTask } from "../chat-context";
import { ClaudeCodeIcon, CodexIcon } from "../agent-icons";
import {
  type AgentMode,
  useAgentMode,
  useSetAgentMode,
} from "../use-agent-mode";

/**
 * Human-readable label for each `HarnessId`. Used by the locked-state
 * tooltip so the user sees "This chat is using Claude Code." rather than
 * a raw id. Kept local to the picker because no other surface needs the
 * mapping today — promote to a shared module if a second consumer
 * appears.
 */
const HARNESS_LABEL: Record<HarnessId, string> = {
  decopilot: "Decopilot",
  "claude-code": "Claude Code",
  codex: "Codex",
};

export interface ModePickerAvailability {
  claudeCode: boolean;
  codex: boolean;
}

interface PureProps {
  mode: AgentMode;
  availability: ModePickerAvailability;
  locked: boolean;
  /**
   * Harness the thread is permanently bound to (from `threads.harness_id`).
   * When non-null and `locked` is true, the trigger surfaces lock-affordance
   * copy that names the runtime instead of the generic mode label. When null
   * the trigger keeps its existing tooltip (the picker may be `locked` for
   * unrelated reasons such as "has prior messages but no thread row yet").
   */
  lockedHarness?: HarnessId | null;
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
  lockedHarness,
  onSelect,
}: PureProps) {
  const [open, setOpen] = useState(false);
  const { icon, text } = pillLabel(mode);
  const isLocal = mode !== "cloud-decopilot";
  const isThreadLocked = locked && lockedHarness != null;
  const harnessLabel = lockedHarness ? HARNESS_LABEL[lockedHarness] : null;

  const handleSelect = (m: AgentMode) => {
    onSelect(m);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={locked ? undefined : setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex min-w-0 shrink">
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="default"
                aria-label={
                  isThreadLocked && harnessLabel
                    ? `This chat is using ${harnessLabel}. Start a new chat to use a different runtime.`
                    : text
                }
                disabled={locked}
                data-testid={
                  isThreadLocked ? "harness-picker-locked" : "harness-picker"
                }
                className={cn(
                  baseClasses,
                  isLocal && localActiveClasses,
                  "shrink min-w-0",
                  locked ? "gap-0" : "gap-0 @[320px]/chat-bottom:gap-1.5",
                )}
              >
                {isThreadLocked && (
                  <Lock01 className="h-3 w-3 shrink-0" aria-hidden="true" />
                )}
                {icon}
                <span
                  className={cn(
                    "min-w-0 truncate transition-[max-width,opacity] duration-200 ease-out max-w-0 opacity-0",
                    !locked &&
                      "@[320px]/chat-bottom:max-w-32 @[320px]/chat-bottom:opacity-100",
                  )}
                >
                  {text}
                </span>
                {!locked && (
                  <ChevronDown
                    size={12}
                    className="opacity-60 hidden @[320px]/chat-bottom:inline-block"
                  />
                )}
              </Button>
            </PopoverTrigger>
          </span>
        </TooltipTrigger>
        <TooltipContent>
          {isThreadLocked && harnessLabel
            ? `This chat is using ${harnessLabel}. Start a new chat to use a different runtime.`
            : text}
        </TooltipContent>
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
  // Source the locked runtime from the active-thread row (Task 4 / Task 5
  // pattern). When non-null we surface lock-affordance copy on the trigger;
  // when null, the `locked` flag may still be true for unrelated reasons
  // (e.g. message-count lock pre-thread-row) and the trigger keeps its
  // existing tooltip.
  const taskCtx = useOptionalChatTask();
  const lockedHarness = taskCtx?.lockedHarness ?? null;

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
      lockedHarness={lockedHarness}
      onSelect={handleSelect}
    />
  );
}
