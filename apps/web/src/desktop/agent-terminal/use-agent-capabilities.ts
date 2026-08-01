import { useQuery } from "@tanstack/react-query";
import { isDesktopAppEnvironment } from "@/hooks/use-is-desktop-app";
import { KEYS } from "@/lib/query-keys";

export type LocalAgentCapability = "claude-code" | "codex" | "opencode";

export interface LocalAgentCapabilities {
  capabilities: LocalAgentCapability[];
  ready: boolean;
}

const EMPTY: LocalAgentCapabilities = { capabilities: [], ready: false };
const EMPTY_RESOLVED: LocalAgentCapabilities = { ...EMPTY, ready: true };

export function parseAgentCapabilities(value: unknown): LocalAgentCapability[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const capabilities = (value as { capabilities?: unknown }).capabilities;
  if (!Array.isArray(capabilities)) return [];
  return capabilities.filter(
    (capability): capability is LocalAgentCapability =>
      capability === "claude-code" ||
      capability === "codex" ||
      capability === "opencode",
  );
}

/** Native-only advisory detection for the coding-agent terminal picker. */
export function useAgentCapabilities(): LocalAgentCapabilities {
  const isDesktopApp = isDesktopAppEnvironment();
  const { data } = useQuery<LocalAgentCapabilities>({
    enabled: isDesktopApp,
    queryKey: KEYS.localAgentCapabilities(),
    queryFn: async () => {
      const response = await fetch("/_local/agent-capabilities");
      if (!response.ok) return EMPTY_RESOLVED;
      return {
        capabilities: parseAgentCapabilities(await response.json()),
        ready: true,
      };
    },
    staleTime: 10_000,
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
  });

  if (!isDesktopApp) return EMPTY_RESOLVED;
  return data ?? EMPTY;
}
