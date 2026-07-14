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
import { Check, ChevronDown, Cloud01, Monitor01 } from "@untitledui/icons";
import {
  getWellKnownDecopilotVirtualMCP,
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  useProjectContext,
  type SandboxProviderKind,
} from "@decocms/mesh-sdk";
import type { HarnessId } from "@/harnesses";
import { AgentAvatar } from "@/web/components/agent-icon";
import { useSandboxStart } from "@/web/components/sandbox/hooks/use-sandbox-start";
import { track } from "@/web/lib/posthog-client";
import { useOptionalChatTask } from "../chat-context";
import { useAgentOptionAvailability } from "../use-agent-availability";
import { agentOptionFor, type AgentOptionAvailability } from "./agent-options";
import { ClaudeCodeIcon, CodexIcon } from "../agent-icons";
import {
  agentModeFromOption,
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
  decopilot: "Super Agent",
  "claude-code": "Claude Code",
  codex: "Codex",
};
const DECOPILOT_ICON = getWellKnownDecopilotVirtualMCP("").icon;

function DecopilotIcon({ compact = false }: { compact?: boolean }) {
  return (
    <AgentAvatar
      icon={DECOPILOT_ICON}
      name="Super Agent"
      size="2xs"
      className={cn(compact ? "size-3.5 rounded-sm" : "size-4 rounded-sm")}
    />
  );
}

export type ModePickerAvailability = AgentOptionAvailability;

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
  label: "Super Agent",
  description: "Runs in an agent sandbox",
  group: "cloud",
  icon: <DecopilotIcon />,
  isAvailable: (a) => a.agentSandbox,
};

const ROW_LOCAL_DECOPILOT: ModeRow = {
  mode: "local-decopilot",
  label: "Super Agent",
  description: "Runs on your desktop",
  group: "local",
  icon: <DecopilotIcon />,
  isAvailable: (a) => a.userDesktop,
};

const ROW_CLAUDE_CODE: ModeRow = {
  mode: "local-claude-code",
  label: "Claude Code",
  description: "Runs via Claude Code CLI",
  group: "local",
  icon: <ClaudeCodeIcon size={16} />,
  isAvailable: (a) => a.userDesktop && a.claudeCode,
};

const ROW_CODEX: ModeRow = {
  mode: "local-codex",
  label: "Codex",
  description: "Runs via Codex CLI",
  group: "local",
  icon: <CodexIcon size={16} />,
  isAvailable: (a) => a.userDesktop && a.codex,
};

const ROWS = [ROW_DECOPILOT, ROW_LOCAL_DECOPILOT, ROW_CLAUDE_CODE, ROW_CODEX];

function bestEffortLockedMode(
  lockedHarness: HarnessId,
  lockedSandbox: SandboxProviderKind | null,
): AgentMode {
  if (lockedHarness === "claude-code") return "local-claude-code";
  if (lockedHarness === "codex") return "local-codex";
  return lockedSandbox === "user-desktop"
    ? "local-decopilot"
    : "cloud-decopilot";
}

export function resolveDisplayedAgentMode({
  selectedMode,
  lockedHarness,
  lockedSandbox,
  isThreadLocked,
}: {
  selectedMode: AgentMode;
  lockedHarness: HarnessId | null;
  lockedSandbox: SandboxProviderKind | null;
  isThreadLocked: boolean;
}): AgentMode {
  if (isThreadLocked && lockedHarness != null) {
    const lockedOption = agentOptionFor(lockedHarness, lockedSandbox);
    if (lockedOption) return agentModeFromOption(lockedOption);
    return bestEffortLockedMode(lockedHarness, lockedSandbox);
  }
  return selectedMode;
}

function harnessPillLabel(mode: AgentMode): {
  icon: React.ReactNode;
  text: string;
} {
  if (mode === "local-decopilot")
    return { icon: <DecopilotIcon compact />, text: "Super Agent" };
  if (mode === "local-claude-code")
    return { icon: <ClaudeCodeIcon size={14} />, text: "Claude Code" };
  if (mode === "local-codex")
    return { icon: <CodexIcon size={14} />, text: "Codex" };
  return { icon: <DecopilotIcon compact />, text: "Super Agent" };
}

function editablePillLabel(mode: AgentMode): {
  icon: React.ReactNode;
  text: string;
} {
  const { text } = harnessPillLabel(mode);
  const icon =
    mode === "cloud-decopilot" ? (
      <Cloud01 size={14} />
    ) : (
      <Monitor01 size={14} />
    );
  return { icon, text };
}

function runtimeLabel(mode: AgentMode): "cloud" | "desktop" {
  return mode === "cloud-decopilot" ? "cloud" : "desktop";
}

const baseClasses =
  "text-muted-foreground hover:text-foreground text-xs transition-[gap] duration-200";
const localPreviewClasses = "text-success hover:text-success";

/**
 * Pure variant — no external dependencies (no context, no queries, no MCP
 * client). Owns only local UI state (the popover open flag) so tests can
 * mount it without mocking the chat context. Renders the closed pill +
 * the popover with sectioned rows.
 */
export function ModePickerPure({
  mode,
  availability,
  locked,
  lockedHarness,
  onSelect,
}: PureProps) {
  const [open, setOpen] = useState(false);
  const { icon, text } = locked
    ? harnessPillLabel(mode)
    : editablePillLabel(mode);
  const labelWithRuntime = `${text} on ${runtimeLabel(mode)}`;
  const isLocal = mode !== "cloud-decopilot";
  const showHarnessLabel = lockedHarness != null;
  const harnessLabel = lockedHarness ? HARNESS_LABEL[lockedHarness] : null;
  const cloudRows = ROWS.filter(
    (row) => row.group === "cloud" && row.isAvailable(availability),
  );
  const localRows = ROWS.filter((row) => row.group === "local");

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
                  showHarnessLabel && harnessLabel
                    ? `This chat is using ${harnessLabel} on ${runtimeLabel(mode)}. Start a new chat to use a different runtime.`
                    : labelWithRuntime
                }
                disabled={locked}
                data-testid={locked ? "mode-picker-locked" : "mode-picker"}
                className={cn(
                  baseClasses,
                  isLocal && localPreviewClasses,
                  "shrink min-w-0",
                  locked ? "gap-0" : "gap-0 @[320px]/chat-bottom:gap-1.5",
                )}
              >
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
          {showHarnessLabel && harnessLabel
            ? `This chat is using ${harnessLabel} on ${runtimeLabel(mode)}. Start a new chat to use a different runtime.`
            : labelWithRuntime}
        </TooltipContent>
      </Tooltip>
      <PopoverContent align="start" className="p-1 w-64">
        <div role="menu" className="flex flex-col">
          {cloudRows.length > 0 && <Section title="Cloud" />}
          {cloudRows.map((row) => (
            <Row
              key={row.mode}
              row={row}
              active={mode === row.mode}
              onSelect={handleSelect}
            />
          ))}
          {localRows.length > 0 && (
            <Section
              title="Local"
              variant="success"
              icon={
                <Monitor01 size={12} data-testid="local-section-desktop-icon" />
              }
              testId="local-section-header"
            />
          )}
          {localRows.map((row) => {
            const available = row.isAvailable(availability);
            return (
              <Row
                key={row.mode}
                row={row}
                active={mode === row.mode}
                onSelect={handleSelect}
                unavailableHint={
                  available
                    ? undefined
                    : availability.userDesktop
                      ? "Not detected on your desktop"
                      : "Desktop not detected"
                }
              />
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function Section({
  title,
  variant = "muted",
  icon,
  testId,
}: {
  title: string;
  variant?: "muted" | "success";
  icon?: React.ReactNode;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      className={cn(
        "inline-flex w-fit items-center gap-2 mx-1 mt-2 mb-1 px-1.5 py-0.5 rounded text-[10px] font-medium uppercase tracking-wide",
        variant === "success"
          ? "bg-success/10 text-success"
          : "text-muted-foreground",
      )}
    >
      {icon}
      <span>{title}</span>
    </div>
  );
}

function Row({
  row,
  active,
  onSelect,
  unavailableHint,
}: {
  row: ModeRow;
  active: boolean;
  onSelect: (mode: AgentMode) => void;
  unavailableHint?: string;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={() => onSelect(row.mode)}
      className={cn(
        "flex items-start gap-2 px-2 py-1.5 rounded-md text-left",
        "hover:bg-muted",
      )}
    >
      <span className="shrink-0 text-muted-foreground mt-0.5">{row.icon}</span>
      <div className="flex-1">
        <div className="text-sm">{row.label}</div>
        <div className="text-xs text-muted-foreground">
          {unavailableHint ?? row.description}
        </div>
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
 * start with the selected provider when a branch is present.
 */
export function ModePicker({
  locked,
  currentBranch,
  virtualMcpId,
}: SmartProps) {
  const selectedMode = useAgentMode();
  const setAgentMode = useSetAgentMode();
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
  const lockedSandbox = taskCtx?.lockedSandbox ?? null;
  const isThreadLocked = taskCtx?.isThreadLocked ?? false;

  // Availability only annotates rows with advisory hints. It must not rewrite
  // the selected/displayed runtime.
  const availability = useAgentOptionAvailability();
  const mode = resolveDisplayedAgentMode({
    selectedMode,
    lockedHarness,
    lockedSandbox,
    isThreadLocked,
  });

  const handleSelect = (next: AgentMode) => {
    setAgentMode(next);
    track("agent_mode_selected", { mode: next });
    if (currentBranch) {
      startVm.mutate({
        virtualMcpId,
        branch: currentBranch,
        sandboxProviderKind:
          next === "cloud-decopilot"
            ? ("agent-sandbox" as const)
            : "user-desktop",
      });
    }
  };

  return (
    <>
      <ModePickerPure
        mode={mode}
        availability={availability}
        locked={locked}
        lockedHarness={lockedHarness}
        onSelect={handleSelect}
      />
    </>
  );
}
