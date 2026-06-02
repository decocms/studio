"use client";

import type { ToolUIPart } from "ai";
import { ArrowRight, UserCircle } from "@untitledui/icons";
import { useNavigate } from "@tanstack/react-router";
import { useProjectContext } from "@decocms/mesh-sdk";
import type { VirtualMCPEntity } from "@decocms/mesh-sdk/types";
import { AgentAvatar } from "@/web/components/agent-icon";
import { AgentConnectionsPreview } from "@/web/components/connections/agent-connections-preview.tsx";
import { useNavigateToAgent } from "@/web/hooks/use-navigate-to-agent";
import { formatDuration } from "@/web/lib/format-time.ts";
import { ToolCallShell } from "./common.tsx";
import { getEffectiveState } from "./utils.tsx";

interface AgentListPartProps {
  part: ToolUIPart;
  latency?: number;
}

// Cap rows shown inline; the rest live behind the "See all" footer row.
const MAX_VISIBLE = 4;

// Built-in tools return the raw object as `part.output`; MCP tools wrap it in
// a CallToolResult ({ content, structuredContent }). Unwrap either shape.
function unwrapResult<T>(output: unknown): T | undefined {
  if (output == null || typeof output !== "object") return undefined;
  const o = output as Record<string, unknown>;
  if (o.structuredContent && typeof o.structuredContent === "object") {
    return o.structuredContent as T;
  }
  if (Array.isArray(o.content)) {
    const first = (o.content as Array<{ type?: string; text?: string }>)[0];
    if (first?.type === "text" && typeof first.text === "string") {
      try {
        return JSON.parse(first.text) as T;
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
  return output as T;
}

function AgentRow({ agent }: { agent: VirtualMCPEntity }) {
  const navigateToAgent = useNavigateToAgent();
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
        <AgentConnectionsPreview
          connectionIds={connectionIds}
          iconSize="xs"
          maxVisibleIcons={3}
        />
      )}
    </button>
  );
}

export function AgentListPart({ part, latency }: AgentListPartProps) {
  const state = getEffectiveState(part.state);
  const result = unwrapResult<{ items?: VirtualMCPEntity[] }>(part.output);
  const items = Array.isArray(result?.items) ? result.items : [];

  const latencyLabel =
    latency != null && latency > 0 ? (
      <span className="text-[11px] font-mono tabular-nums text-muted-foreground">
        {formatDuration(latency)}
      </span>
    ) : null;

  if (state === "loading") {
    return (
      <ToolCallShell
        icon={<UserCircle className="animate-pulse" />}
        title="Loading agents"
        state="loading"
      />
    );
  }

  if (state === "error") {
    return (
      <ToolCallShell
        icon={<UserCircle />}
        title="Couldn't load agents"
        state="error"
        trailing={latencyLabel}
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
        trailing={latencyLabel}
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
        trailing={latencyLabel}
      />
      <div className="mt-2 flex flex-col gap-1.5">
        {visible.map((agent) => (
          <AgentRow key={agent.id} agent={agent} />
        ))}
        {hiddenCount > 0 && <SeeAllRow count={items.length} />}
      </div>
    </>
  );
}

function SeeAllRow({ count }: { count: number }) {
  const navigate = useNavigate();
  const { org } = useProjectContext();

  return (
    <button
      type="button"
      onClick={() =>
        navigate({ to: "/$org/settings/agents", params: { org: org.slug } })
      }
      className="group flex w-full items-center justify-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground cursor-pointer"
    >
      See all {count} agents
      <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
    </button>
  );
}
