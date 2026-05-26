/**
 * useStudioPackChecklists
 *
 * Loads per-Studio-Pack-agent onboarding checklists. Each item's
 * `completed` flag is derived server-side from current org state, so
 * checks flip as the user creates brands, agents, connections, etc.
 */

import { useQuery } from "@tanstack/react-query";
import { KEYS } from "@/web/lib/query-keys";

export type ChecklistItemAction =
  | { kind: "open-agent-thread"; prompt: string }
  | { kind: "github-import" }
  | { kind: "install-github-mcp" }
  | { kind: "add-storefront" }
  | { kind: "configure-github-automations" }
  | { kind: "setup-site-monitoring" };

export interface StudioPackChecklistItem {
  label: string;
  activeForm: string;
  action: ChecklistItemAction;
  completed: boolean;
}

export interface StudioPackChecklist {
  agent: {
    id: string;
    name: string;
    icon: string | null;
  };
  items: StudioPackChecklistItem[];
}

interface StudioPackChecklistsResponse {
  checklists: StudioPackChecklist[];
}

export function useStudioPackChecklists(orgSlug: string) {
  const queryKey = KEYS.studioPackChecklists(orgSlug);

  const query = useQuery({
    queryKey,
    queryFn: async (): Promise<StudioPackChecklist[]> => {
      const res = await fetch(`/api/${orgSlug}/studio-pack-checklists`);
      if (!res.ok) throw new Error("Failed to load studio pack checklists");
      const body = (await res.json()) as StudioPackChecklistsResponse;
      return body.checklists;
    },
    staleTime: 0,
    refetchOnWindowFocus: "always",
  });

  return {
    isLoading: query.isLoading,
    checklists: query.data ?? [],
  };
}
