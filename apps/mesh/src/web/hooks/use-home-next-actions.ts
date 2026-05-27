import { useQuery } from "@tanstack/react-query";
import type { Prompt } from "@modelcontextprotocol/sdk/types.js";
import { KEYS } from "@/web/lib/query-keys";

export type DialogKind =
  | "install-github-mcp"
  | "add-storefront"
  | "configure-github-automations"
  | "setup-site-monitoring"
  | "github-import";

export interface HomePromptEntry {
  agentId: string;
  agentName: string;
  agentIcon: string | null;
  promptName: string;
  title: string;
  description: string;
  hasArguments: boolean;
  arguments?: Prompt["arguments"];
}

export interface HomeDialogEntry {
  agentId: string;
  agentName: string;
  agentIcon: string | null;
  label: string;
  kind: DialogKind;
}

interface HomeNextActionsResponse {
  prompts: HomePromptEntry[];
  dialogs: HomeDialogEntry[];
}

export function useHomeNextActions(orgSlug: string) {
  const query = useQuery({
    queryKey: KEYS.homeNextActions(orgSlug),
    queryFn: async (): Promise<HomeNextActionsResponse> => {
      const res = await fetch(`/api/${orgSlug}/home-next-actions`);
      if (!res.ok) throw new Error("Failed to load home next actions");
      return (await res.json()) as HomeNextActionsResponse;
    },
    staleTime: 0,
    refetchOnWindowFocus: "always",
  });

  return {
    isLoading: query.isLoading,
    prompts: query.data?.prompts ?? [],
    dialogs: query.data?.dialogs ?? [],
  };
}
