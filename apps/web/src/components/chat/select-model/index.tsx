import {
  DecopilotModelSelectorBody,
  DecopilotModelSelectorStandalone,
} from "./decopilot";
import type { AiProviderModel } from "@/hooks/collections/use-ai-providers";

interface BodyProps {
  onClose: () => void;
}

/**
 * Hosted chat model picker. Native coding agents own their model selection in
 * their TUI and never render this component.
 */
export function ModelSelectorBody({ onClose }: BodyProps) {
  return <DecopilotModelSelectorBody onClose={onClose} />;
}

interface StandaloneProps {
  onClose: () => void;
  credentialId: string | null;
  onCredentialChange: (id: string | null) => void;
  selectedModel: AiProviderModel | null;
  onModelChange: (model: AiProviderModel) => void;
  filterModels?: (m: AiProviderModel) => boolean;
  /** Single-column layout, no hover details panel — for embedding in a small
   *  popover rather than the full-size Dialog/Drawer. */
  compact?: boolean;
}

export function ModelSelectorStandaloneBody({ ...rest }: StandaloneProps) {
  return <DecopilotModelSelectorStandalone {...rest} />;
}
