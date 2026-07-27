// apps/web/src/components/chat/select-model/index.tsx
import type { HarnessId } from "@decocms/harness/types";
import {
  DecopilotModelSelectorBody,
  DecopilotModelSelectorStandalone,
} from "./decopilot";
import { DesktopCliModelSelectorBody } from "./desktop-cli";
import { getAgentModelSet } from "./agent-models";
import { useChatPrefs } from "../context";
import { useT } from "@/i18n/use-t";
import type { AiProviderModel } from "@/hooks/collections/use-ai-providers";

interface BodyProps {
  onClose: () => void;
  /** Explicit lock — automations pass "decopilot" to ignore chat prefs. */
  agent?: HarnessId;
}

/**
 * Renders the model picker matching the active agent.
 * Decopilot → existing two-pane API-key selector.
 * Claude Code / Codex → fixed three-tier picker, no key dropdown.
 *
 * The cloud/local runtime choice lives in the chat's TierTrigger pill (the
 * control users actually see), not here — this body is reached from the
 * settings/automations model pickers.
 */
export function ModelSelectorBody({ onClose, agent }: BodyProps) {
  const t = useT();
  const prefs = useChatPrefs();
  const effective = agent ?? prefs.pendingHarnessId ?? "decopilot";
  const cli = getAgentModelSet(effective, t);

  if (!cli) {
    return <DecopilotModelSelectorBody onClose={onClose} />;
  }

  return (
    <DesktopCliModelSelectorBody
      modelSet={cli}
      selectedModelId={
        prefs.selectedModel?.modelId ?? cli.tiers[prefs.simpleModeTier].modelId
      }
      onSelect={(model) => {
        prefs.setModel({ ...model, keyId: undefined });
        onClose();
      }}
    />
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
  /** Single-column layout, no hover details panel — for embedding in a small
   *  popover rather than the full-size Dialog/Drawer. Ignored for CLI harness
   *  model sets, which are already a fixed compact list. */
  compact?: boolean;
}

export function ModelSelectorStandaloneBody({
  agent,
  ...rest
}: StandaloneProps) {
  const t = useT();
  const cli = agent ? getAgentModelSet(agent, t) : null;
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
