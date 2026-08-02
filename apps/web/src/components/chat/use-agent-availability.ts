import { useCurrentLink } from "@/hooks/use-current-link";
import { useIsDesktopApp } from "@/hooks/use-is-desktop-app";
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
  const isDesktopApp = useIsDesktopApp();
  const publicConfig = usePublicConfig();
  const localMachineAvailable = isDesktopApp && link.online;
  return {
    agentSandbox: publicConfig.runtime.agentSandbox,
    userDesktop: localMachineAvailable,
    claudeCode:
      localMachineAvailable && link.capabilities.includes("claude-code"),
    codex: localMachineAvailable && link.capabilities.includes("codex"),
  };
}
