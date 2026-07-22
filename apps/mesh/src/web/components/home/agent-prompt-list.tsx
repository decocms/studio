import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
  useMCPClient,
  useProjectContext,
  type VirtualMCPEntity,
} from "@decocms/mesh-sdk";
import { Skeleton } from "@deco/ui/components/skeleton.tsx";
import { toast } from "sonner";
import { useT } from "@/web/i18n/use-t.ts";
import { useHomeNextActions } from "@/web/hooks/use-home-next-actions";
import { KEYS } from "@/web/lib/query-keys";
import { toTitleCase } from "@/web/components/chat/message/parts/tool-call-part/utils";
import { HOME_LIMIT, type HomeBoard } from "./add-tile-drawer";
import { ToggleButton } from "./toggle-button";

interface AgentPrompt {
  name: string;
  title?: string;
  description?: string;
}

/**
 * Lists every prompt the agent's gateway exposes. Pin/unpin writes to
 * `metadata.ui.homePrompts` — when that field is null/absent the home
 * surfaces all prompts (default), when it's an array (even empty) the
 * BE honors that list verbatim.
 */
export function AgentPromptList({
  agent,
  home,
  curated,
}: {
  agent: VirtualMCPEntity;
  home: HomeBoard;
  curated: string[] | null;
}) {
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: agent.id,
    orgId: org.id,
    orgSlug: org.slug,
  });

  const { data, isLoading, error } = useQuery({
    queryKey: KEYS.agentPrompts(org.id, agent.id),
    queryFn: async (): Promise<AgentPrompt[]> => {
      const { prompts } = await client.listPrompts();
      return prompts.map((p) => ({
        name: p.name,
        title: p.title,
        description: p.description,
      }));
    },
    staleTime: 30_000,
    retry: false,
  });

  // Studio Pack agents and others whose gateway doesn't surface prompts
  // via `prompts/list` still emit them through the home-next-actions
  // endpoint (checklist items, etc). Merge that as a fallback source.
  const homeNextActions = useHomeNextActions(org.slug);
  const fromHome: AgentPrompt[] = homeNextActions.prompts
    .filter((p) => p.agentId === agent.id && p.promptName)
    .map((p) => ({
      name: p.promptName,
      title: p.title,
      description: p.description,
    }));

  const merged: AgentPrompt[] = [...(data ?? [])];
  for (const p of fromHome) {
    if (!merged.some((m) => m.name === p.name)) merged.push(p);
  }

  if (isLoading && fromHome.length === 0) {
    return (
      <div className="flex flex-col gap-1">
        <Skeleton className="h-7 w-full" />
        <Skeleton className="h-7 w-2/3" />
      </div>
    );
  }
  if (error && fromHome.length === 0) {
    console.error("[home-tiles] listPrompts failed for agent", agent.id, error);
    return null;
  }
  if (merged.length === 0) {
    return null;
  }

  // When `homePrompts` is null/absent, all prompts are surfaced — every
  // row reads as pinned so the default "all on" state is conveyed by
  // the buttons themselves.
  const pinnedNames = new Set(curated ?? merged.map((p) => p.name));

  return (
    <div className="flex flex-col gap-0.5">
      {merged.map((prompt) => (
        <PromptRow
          key={prompt.name}
          agent={agent}
          home={home}
          prompt={prompt}
          allPromptNames={merged.map((p) => p.name)}
          isPinned={pinnedNames.has(prompt.name)}
        />
      ))}
    </div>
  );
}

function PromptRow({
  agent,
  home,
  prompt,
  allPromptNames,
  isPinned,
}: {
  agent: VirtualMCPEntity;
  home: HomeBoard;
  prompt: AgentPrompt;
  /** Every prompt the agent exposes — used when transitioning from
   *  "all (uncurated)" to "curated" so we don't drop everything. */
  allPromptNames: string[];
  isPinned: boolean;
}) {
  const t = useT();
  const [submitting, setSubmitting] = useState(false);

  const handleClick = async () => {
    if (!isPinned && !home.isOnHome(agent.id) && home.atLimit) {
      toast.error(t("home.agentPromptList.homeIsFull", { limit: HOME_LIMIT }));
      return;
    }
    setSubmitting(true);
    try {
      // Compute next `homePrompts`. Three states:
      //  - uncurated (null) + Remove → keep every prompt except this one
      //  - curated array + Add → append name
      //  - curated array + Remove → filter out name
      const current = agent.metadata?.ui?.homePrompts;
      let nextHomePrompts: string[];
      if (!Array.isArray(current)) {
        nextHomePrompts = isPinned
          ? allPromptNames.filter((n) => n !== prompt.name)
          : allPromptNames; // unreachable: pinned=true in uncurated mode
      } else {
        nextHomePrompts = isPinned
          ? current.filter((n) => n !== prompt.name)
          : [...current, prompt.name];
      }
      const nextMetadata = {
        ...(agent.metadata ?? {}),
        ui: {
          ...(agent.metadata?.ui ?? {}),
          homePrompts: nextHomePrompts,
        },
      };
      await home.saveAgentMetadata(agent, nextMetadata);
    } catch (err) {
      console.error("[home-tiles] failed to toggle prompt", err);
      toast.error(t("home.agentPromptList.couldntUpdateHome"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex items-center gap-2.5 rounded-md px-2 py-1 hover:bg-accent/40">
      <div className="min-w-0 flex-1 truncate text-sm text-foreground">
        {prompt.title ?? toTitleCase(prompt.name)}
      </div>
      <ToggleButton
        isPinned={isPinned}
        submitting={submitting}
        onClick={handleClick}
        label={
          isPinned
            ? t("home.agentPromptList.removeFromHome")
            : t("home.agentPromptList.addToHome")
        }
      />
    </div>
  );
}
