import { useCurrentLink } from "@/hooks/use-current-link";
import { usePublicConfig } from "@/hooks/use-public-config";
import type { AgentOptionAvailability } from "./pills/agent-options";

/**
 * Runtime availability of each agent option for the current org/session.
 *
 * Advisory-only source consumed by the mode picker for status copy. It should
 * never gate selection or rewrite the runtime the chat dispatches.
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
