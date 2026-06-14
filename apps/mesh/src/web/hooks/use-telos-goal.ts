import { KEYS } from "@/web/lib/query-keys";
import { useTelosEvents } from "@/web/hooks/use-telos-events";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export interface TelosGoalTool {
  label: string;
  match: string[];
  appName?: string;
  icon?: string;
}

export interface TelosGoal {
  title: string;
  tools: TelosGoalTool[];
  version: number;
  source: string;
}

export interface TelosToolProgress {
  label: string;
  connected: boolean;
}

export interface TelosFact {
  id: string;
  label: string;
  value: string;
  confidence: string;
  status: "proposed" | "confirmed" | "rejected";
  sourceUrl: string | null;
}

export interface TelosSuggestion {
  kind: string;
  reason?: string;
  version: number;
}

export interface TelosThought {
  text: string;
  phase: "research" | "pursuit";
  version?: number;
}

export interface TelosState {
  goal: TelosGoal | null;
  facts: TelosFact[];
  suggestion: TelosSuggestion | null;
  thought: TelosThought | null;
  progress: TelosToolProgress[] | null;
  status: "researching" | "ready";
}

function telosGoalQueryOptions(orgSlug: string) {
  return {
    queryKey: KEYS.telosGoal(orgSlug),
    queryFn: async (): Promise<TelosState> => {
      const res = await fetch(`/api/${orgSlug}/telos-goal`, {
        cache: "no-store" as const,
      });
      if (!res.ok) throw new Error("Failed to load telos goal");
      return (await res.json()) as TelosState;
    },
    staleTime: 0,
  };
}

export function useTelosGoal(orgSlug: string) {
  const query = useQuery(telosGoalQueryOptions(orgSlug));
  const client = useQueryClient();

  // Live updates over SSE, no polling. Thoughts and suggestions stream in and
  // patch the cache in place (real-time feedback, no round-trip); goal/fact
  // changes refetch the authoritative state.
  useTelosEvents(orgSlug, (evt) => {
    if (evt.type === "telos.goal.thought") {
      client.setQueryData(
        KEYS.telosGoal(orgSlug),
        (prev: TelosState | undefined) =>
          prev
            ? {
                ...prev,
                thought: {
                  text: String(evt.data.text ?? ""),
                  phase: evt.data.phase === "research" ? "research" : "pursuit",
                  version:
                    typeof evt.data.version === "number"
                      ? evt.data.version
                      : undefined,
                },
              }
            : prev,
      );
      return;
    }
    if (evt.type === "telos.goal.suggestion") {
      client.setQueryData(
        KEYS.telosGoal(orgSlug),
        (prev: TelosState | undefined) =>
          prev
            ? {
                ...prev,
                suggestion: {
                  kind: String(evt.data.kind ?? ""),
                  reason:
                    typeof evt.data.reason === "string"
                      ? evt.data.reason
                      : undefined,
                  version:
                    typeof evt.data.version === "number" ? evt.data.version : 0,
                },
              }
            : prev,
      );
      return;
    }
    client.invalidateQueries({ queryKey: KEYS.telosGoal(orgSlug) });
  });

  const setFactStatus = useMutation({
    mutationFn: async (input: {
      id: string;
      status: "confirmed" | "rejected";
    }) => {
      const res = await fetch(`/api/${orgSlug}/telos-facts/${input.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: input.status }),
      });
      if (!res.ok) throw new Error("Failed to update fact");
    },
    onSuccess: () =>
      client.invalidateQueries({ queryKey: KEYS.telosGoal(orgSlug) }),
  });

  return {
    isLoading: query.isLoading,
    goal: query.data?.goal ?? null,
    facts: query.data?.facts ?? [],
    suggestion: query.data?.suggestion ?? null,
    thought: query.data?.thought ?? null,
    progress: query.data?.progress ?? null,
    status: query.data?.status ?? "researching",
    confirmFact: (id: string) =>
      setFactStatus.mutate({ id, status: "confirmed" }),
    rejectFact: (id: string) =>
      setFactStatus.mutate({ id, status: "rejected" }),
  };
}
