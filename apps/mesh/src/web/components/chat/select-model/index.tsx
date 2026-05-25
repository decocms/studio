// apps/mesh/src/web/components/chat/select-model/index.tsx
import type { HarnessId } from "@/harnesses";
import {
  DecopilotModelSelectorBody,
  DecopilotModelSelectorStandalone,
} from "./decopilot";
import { DesktopCliModelSelectorBody } from "./desktop-cli";
import { getAgentModelSet } from "./agent-models";
import { useChatPrefs } from "../context";
import type { AiProviderModel } from "@/web/hooks/collections/use-ai-providers";

interface BodyProps {
  onClose: () => void;
  /** Explicit lock — automations pass "decopilot" to ignore chat prefs. */
  agent?: HarnessId;
}

/**
 * Renders the model picker matching the active agent.
 * Decopilot → existing two-pane API-key selector.
 * Claude Code / Codex → fixed three-tier picker, no key dropdown.
 */
export function ModelSelectorBody({ onClose, agent }: BodyProps) {
  const prefs = useChatPrefs();
  const effective = agent ?? prefs.pendingHarnessId ?? "decopilot";
  const cli = getAgentModelSet(effective);

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
