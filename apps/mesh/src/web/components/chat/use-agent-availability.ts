import { useCurrentLink } from "@/web/hooks/use-current-link";
import { usePublicConfig } from "@/web/hooks/use-public-config";
import type { AgentOptionAvailability } from "./pills/agent-options";

/**
 * Runtime availability of each agent option for the current org/session.
 *
 * Single source consumed by both the mode picker (display) and the chat submit
 * path (dispatch pins) via `chat-context`, so the runtime the user sees
 * selected and the runtime the message dispatches to can never diverge.
 */
export function useAgentOptionAvailability(): AgentOptionAvailability {
  const link = useCurrentLink();
  const publicConfig = usePublicConfig();
  return {
    agentSandbox: publicConfig.runtime.agentSandbox,
    userDesktop: link.online,
    claudeCode: link.online && link.capabilities.includes("claude-code"),
    codex: link.online && link.capabilities.includes("codex"),
  };
}
