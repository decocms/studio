"use client";

import type { ToolUIPart } from "ai";
import { Suspense } from "react";
import { UserCircle } from "@untitledui/icons";
import { useNavigate } from "@tanstack/react-router";
import { useProjectContext } from "@decocms/mesh-sdk";
import type { VirtualMCPEntity } from "@decocms/mesh-sdk/types";
import { AgentAvatar } from "@/web/components/agent-icon";
import { useNavigateToAgent } from "@/web/hooks/use-navigate-to-agent";
import {
  ToolCallShell,
  LatencyLabel,
  SeeAllRow,
  MAX_VISIBLE,
} from "./common.tsx";
import { getEffectiveState, unwrapResult } from "./utils.tsx";
import { AgentConnectionsPreview } from "./agent-connections-preview.tsx";

interface AgentListPartProps {
  part: ToolUIPart;
  latency?: number;
}

function AgentRow({ agent }: { agent: VirtualMCPEntity }) {
  const navigateToAgent = useNavigateToAgent();
  if (!agent.id) return null;
  const connectionIds = (agent.connections ?? []).map((c) => c.connection_id);

  return (
    <button
      type="button"
      onClick={() => navigateToAgent(agent.id)}
      className="group flex w-full items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5 text-left transition-colors hover:bg-muted cursor-pointer"
    >
      <AgentAvatar icon={agent.icon} name={agent.title} size="sm" />
      <div className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="truncate text-sm font-medium text-foreground">
          {agent.title}
        </span>
        {agent.description && (
          <span className="truncate text-xs text-muted-foreground">
            {agent.description}
          </span>
        )}
      </div>
      {connectionIds.length > 0 && (
        <Suspense
          fallback={
            <AgentConnectionsPreview.Fallback
              iconSize="xs"
              maxVisibleIcons={3}
              totalCount={connectionIds.length}
            />
          }
        >
          <AgentConnectionsPreview
            connectionIds={connectionIds}
            iconSize="xs"
            maxVisibleIcons={3}
          />
        </Suspense>
      )}
    </button>
  );
}

export function AgentListPart({ part, latency }: AgentListPartProps) {
  const navigate = useNavigate();
  const { org } = useProjectContext();
  const state = getEffectiveState(part.state);
  const result = unwrapResult<{ items?: VirtualMCPEntity[] }>(part.output);
  const items = Array.isArray(result?.items) ? result.items : [];

  if (state === "loading") {
    return (
      <ToolCallShell
        icon={<UserCircle className="animate-pulse" />}
        title="Loading agents"
        state="loading"
      />
    );
  }

  if (state === "approval") {
    return (
      <ToolCallShell icon={<UserCircle />} title="List agents" state="idle" />
    );
  }

  if (state === "error") {
    return (
      <ToolCallShell
        icon={<UserCircle />}
        title={
          part.state === "output-denied"
            ? "Agent list unavailable"
            : "Couldn't load agents"
        }
        state="error"
        trailing={<LatencyLabel latency={latency} />}
      />
    );
  }

  if (items.length === 0) {
    return (
      <ToolCallShell
        icon={<UserCircle />}
        title="No agents yet"
        summary="This organization hasn't created any agents."
        state="idle"
        trailing={<LatencyLabel latency={latency} />}
      />
    );
  }

  const visible = items.slice(0, MAX_VISIBLE);
  const hiddenCount = items.length - visible.length;

  return (
    <>
      <ToolCallShell
        icon={<UserCircle className="text-emerald-500" />}
        title={items.length === 1 ? "1 agent" : `${items.length} agents`}
        state="idle"
        trailing={<LatencyLabel latency={latency} />}
      />
      <div className="mt-2 flex flex-col gap-1.5">
        {visible.map((agent) => (
          <AgentRow key={agent.id} agent={agent} />
        ))}
        {hiddenCount > 0 && (
          <SeeAllRow
            count={items.length}
            noun="agents"
            onClick={() =>
              navigate({
                to: "/$org/settings/agents",
                params: { org: org.slug },
              })
            }
          />
        )}
      </div>
    </>
  );
}
