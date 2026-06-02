"use client";

import type { ToolUIPart } from "ai";
import { ArrowRight, Link01 } from "@untitledui/icons";
import { useNavigate } from "@tanstack/react-router";
import { useProjectContext } from "@decocms/mesh-sdk";
import type { ConnectionEntity } from "@decocms/mesh-sdk/types";
import { IntegrationIcon } from "@/web/components/integration-icon";
import { cn } from "@deco/ui/lib/utils.ts";
import { formatDuration } from "@/web/lib/format-time.ts";
import { ToolCallShell } from "./common.tsx";
import { getEffectiveState } from "./utils.tsx";

interface ConnectionListPartProps {
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

const STATUS_DOT: Record<ConnectionEntity["status"], string> = {
  active: "bg-emerald-500",
  inactive: "bg-muted-foreground",
  error: "bg-destructive",
};

function ConnectionRow({ connection }: { connection: ConnectionEntity }) {
  const navigate = useNavigate();
  const { org } = useProjectContext();
  const slug = connection.slug;
  const subtitle = connection.description || connection.app_name;

  return (
    <button
      type="button"
      disabled={!slug}
      onClick={() =>
        slug &&
        navigate({
          to: "/$org/settings/connections/$appSlug",
          params: { org: org.slug, appSlug: slug },
        })
      }
      className="group flex w-full items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5 text-left transition-colors hover:bg-muted cursor-pointer disabled:cursor-default disabled:hover:bg-card"
    >
      <IntegrationIcon
        icon={connection.icon}
        name={connection.title}
        size="sm"
      />
      <div className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="truncate text-sm font-medium text-foreground">
          {connection.title}
        </span>
        {subtitle && (
          <span className="truncate text-xs text-muted-foreground">
            {subtitle}
          </span>
        )}
      </div>
      <span
        className={cn(
          "size-2 shrink-0 rounded-full",
          STATUS_DOT[connection.status],
        )}
        title={connection.status}
        aria-hidden
      />
    </button>
  );
}

export function ConnectionListPart({ part, latency }: ConnectionListPartProps) {
  const state = getEffectiveState(part.state);
  const result = unwrapResult<{ items?: ConnectionEntity[] }>(part.output);
  // Defensively exclude VIRTUAL connections (agents) — they have their own card.
  const items = (Array.isArray(result?.items) ? result.items : []).filter(
    (c) => c.connection_type !== "VIRTUAL",
  );

  const latencyLabel =
    latency != null && latency > 0 ? (
      <span className="text-[11px] font-mono tabular-nums text-muted-foreground">
        {formatDuration(latency)}
      </span>
    ) : null;

  if (state === "loading") {
    return (
      <ToolCallShell
        icon={<Link01 className="animate-pulse" />}
        title="Loading connections"
        state="loading"
      />
    );
  }

  if (state === "error") {
    return (
      <ToolCallShell
        icon={<Link01 />}
        title="Couldn't load connections"
        state="error"
        trailing={latencyLabel}
      />
    );
  }

  if (items.length === 0) {
    return (
      <ToolCallShell
        icon={<Link01 />}
        title="No connections yet"
        summary="This organization hasn't connected any MCPs."
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
        icon={<Link01 className="text-emerald-500" />}
        title={
          items.length === 1 ? "1 connection" : `${items.length} connections`
        }
        state="idle"
        trailing={latencyLabel}
      />
      <div className="mt-2 flex flex-col gap-1.5">
        {visible.map((connection) => (
          <ConnectionRow key={connection.id} connection={connection} />
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
        navigate({
          to: "/$org/settings/connections",
          params: { org: org.slug },
        })
      }
      className="group flex w-full items-center justify-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground cursor-pointer"
    >
      See all {count} connections
      <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
    </button>
  );
}
