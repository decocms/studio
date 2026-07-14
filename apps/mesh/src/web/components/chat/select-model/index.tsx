// apps/mesh/src/web/components/chat/select-model/index.tsx
import type { ReactNode } from "react";
import { Cloud01, Monitor01 } from "@untitledui/icons";
import { cn } from "@deco/ui/lib/utils.ts";
import type { HarnessId } from "@/harnesses";
import type { ChatTier } from "@/tools/organization/schema";
import {
  DecopilotModelSelectorBody,
  DecopilotModelSelectorStandalone,
} from "./decopilot";
import { DesktopCliModelSelectorBody } from "./desktop-cli";
import { getAgentModelSet } from "./agent-models";
import { useChatPrefs, useOptionalChatTask } from "../context";
import { useAgentOptionAvailability } from "../use-agent-availability";
import type { AgentOption } from "../pills/agent-options";
import type { AiProviderModel } from "@/web/hooks/collections/use-ai-providers";
import { ClaudeCodeIcon, CodexIcon } from "../agent-icons";

interface BodyProps {
  onClose: () => void;
  /** Explicit lock — automations pass "decopilot" to ignore chat prefs. */
  agent?: HarnessId;
}

/** The local coding agents we can route to, in display order. */
const LOCAL_CLIS: Array<{
  harness: Extract<HarnessId, "claude-code" | "codex">;
  option: AgentOption;
  label: string;
  icon: ReactNode;
}> = [
  {
    harness: "claude-code",
    option: "claude-code-desktop",
    label: "Claude",
    icon: <ClaudeCodeIcon size={14} />,
  },
  {
    harness: "codex",
    option: "codex-desktop",
    label: "Codex",
    icon: <CodexIcon size={14} />,
  },
];

/** Map a concrete CLI model id back to the tier that maps to it. */
function tierForModelId(harness: HarnessId, modelId: string): ChatTier | null {
  const set = getAgentModelSet(harness);
  if (!set) return null;
  for (const tier of ["fast", "smart", "thinking"] as const) {
    if (set.tiers[tier].modelId === modelId) return tier;
  }
  return null;
}

/**
 * Cloud (org router) ⟷ This device segmented toggle. Only rendered when the
 * user has a linked desktop with at least one coding agent — otherwise the
 * whole notion of "local" is meaningless and we show cloud only.
 */
const RUNTIME_TOGGLE_BTN =
  "flex items-center justify-center gap-1.5 flex-1 rounded-md px-2 py-1.5 text-sm transition-colors";
const RUNTIME_TOGGLE_ACTIVE = "bg-background text-foreground shadow-sm";
const RUNTIME_TOGGLE_INACTIVE = "text-muted-foreground hover:text-foreground";

function RuntimeToggle({
  local,
  onSelect,
}: {
  local: boolean;
  onSelect: (local: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-1 m-2 mb-0 p-1 rounded-lg bg-muted">
      <button
        type="button"
        className={cn(
          RUNTIME_TOGGLE_BTN,
          local ? RUNTIME_TOGGLE_INACTIVE : RUNTIME_TOGGLE_ACTIVE,
        )}
        onClick={() => onSelect(false)}
      >
        <Cloud01 size={14} />
        Org router
      </button>
      <button
        type="button"
        className={cn(
          RUNTIME_TOGGLE_BTN,
          local ? RUNTIME_TOGGLE_ACTIVE : RUNTIME_TOGGLE_INACTIVE,
        )}
        onClick={() => onSelect(true)}
      >
        <Monitor01 size={14} />
        This device
      </button>
    </div>
  );
}

/**
 * Local models grouped by coding agent (Claude / Codex). Picking a row binds
 * the chat to that CLI (harness + user-desktop sandbox via `pendingAgentOption`)
 * and sets the tier the row maps to. Only the CLIs actually detected on the
 * linked desktop are shown.
 */
function LocalModelSelector({
  claudeCode,
  codex,
  currentHarness,
  onClose,
}: {
  claudeCode: boolean;
  codex: boolean;
  currentHarness: HarnessId;
  onClose: () => void;
}) {
  const { simpleModeTier, setSimpleModeTier, setPendingAgentOption } =
    useChatPrefs();
  const available = LOCAL_CLIS.filter((c) =>
    c.harness === "claude-code" ? claudeCode : codex,
  );

  const handleSelect = (option: AgentOption, model: AiProviderModel) => {
    const harness = option === "claude-code-desktop" ? "claude-code" : "codex";
    const tier = tierForModelId(harness, model.modelId);
    setPendingAgentOption(option);
    if (tier) setSimpleModeTier(tier);
    onClose();
  };

  return (
    <div className="flex flex-col pb-1 w-[320px]">
      {available.map((cli) => {
        const set = getAgentModelSet(cli.harness);
        if (!set) return null;
        const selectedModelId =
          currentHarness === cli.harness
            ? (set.tiers[simpleModeTier as ChatTier]?.modelId ?? null)
            : null;
        return (
          <div key={cli.harness}>
            <div className="flex items-center gap-1.5 mx-3 mt-2 mb-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              {cli.icon}
              {cli.label}
            </div>
            <DesktopCliModelSelectorBody
              modelSet={set}
              selectedModelId={selectedModelId}
              onSelect={(model) => handleSelect(cli.option, model)}
            />
          </div>
        );
      })}
    </div>
  );
}

/**
 * Chat model picker. The single control for both *which model* and *where it
 * runs* — the runtime is never named to the user as a separate "harness".
 *
 * - Default: the org router (cloud). `DecopilotModelSelectorBody` — provider
 *   keys + tiers, resolved server-side.
 * - When a desktop is linked with a coding agent, a "This device" toggle
 *   appears; flipping it lists the local models (Claude / Codex) and binds the
 *   chat to that CLI. Hidden on a locked thread (runtime is immutable there).
 */
export function ModelSelectorBody({ onClose, agent }: BodyProps) {
  const prefs = useChatPrefs();
  const availability = useAgentOptionAvailability();
  const taskCtx = useOptionalChatTask();
  const locked = taskCtx?.isThreadLocked ?? false;

  const effectiveHarness = agent ?? prefs.pendingHarnessId ?? "decopilot";
  const isLocal =
    effectiveHarness === "claude-code" || effectiveHarness === "codex";
  const hasLocal = availability.claudeCode || availability.codex;
  const showToggle = !agent && !locked && hasLocal;

  const onToggle = (local: boolean) => {
    if (!local) {
      prefs.setPendingAgentOption("decopilot");
      return;
    }
    prefs.setPendingAgentOption(
      availability.claudeCode ? "claude-code-desktop" : "codex-desktop",
    );
  };

  return (
    <div className="flex flex-col">
      {showToggle && <RuntimeToggle local={isLocal} onSelect={onToggle} />}
      {isLocal ? (
        <LocalModelSelector
          claudeCode={availability.claudeCode}
          codex={availability.codex}
          currentHarness={effectiveHarness}
          onClose={onClose}
        />
      ) : (
        <DecopilotModelSelectorBody onClose={onClose} />
      )}
    </div>
  );
}

interface StandaloneProps {
  onClose: () => void;
  agent?: HarnessId;
  credentialId: string | null;
  onCredentialChange: (id: string | null) => void;
  selectedModel: AiProviderModel | null;
  onModelChange: (model: AiProviderModel) => void;
  filterModels?: (m: AiProviderModel) => boolean;
}

export function ModelSelectorStandaloneBody({
  agent,
  ...rest
}: StandaloneProps) {
  const cli = agent ? getAgentModelSet(agent) : null;
  if (!cli) return <DecopilotModelSelectorStandalone {...rest} />;
  return (
    <DesktopCliModelSelectorBody
      modelSet={cli}
      selectedModelId={rest.selectedModel?.modelId ?? cli.tiers.smart.modelId}
      onSelect={(model) => {
        rest.onModelChange(model);
        rest.onClose();
      }}
    />
  );
}
