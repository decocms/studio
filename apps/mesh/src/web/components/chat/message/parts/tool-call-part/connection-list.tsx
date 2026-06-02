"use client";

import type { ToolUIPart } from "ai";
import { Link01 } from "@untitledui/icons";
import { useNavigate } from "@tanstack/react-router";
import { useProjectContext } from "@decocms/mesh-sdk";
import type { ConnectionEntity } from "@decocms/mesh-sdk/types";
import { IntegrationIcon } from "@/web/components/integration-icon";
import { cn } from "@deco/ui/lib/utils.ts";
import { ToolCallShell, LatencyLabel, SeeAllRow } from "./common.tsx";
import { getEffectiveState, unwrapResult } from "./utils.tsx";

interface ConnectionListPartProps {
  part: ToolUIPart;
  latency?: number;
}

const MAX_VISIBLE = 4;

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
      aria-disabled={!slug || undefined}
      onClick={() =>
        slug &&
        navigate({
          to: "/$org/settings/connections/$appSlug",
          params: { org: org.slug, appSlug: slug },
        })
      }
      className="group flex w-full items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5 text-left transition-colors hover:bg-muted cursor-pointer aria-disabled:cursor-default aria-disabled:hover:bg-card"
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
          STATUS_DOT[connection.status] ?? "bg-muted-foreground",
        )}
        aria-hidden="true"
      />
      <span className="sr-only">{connection.status}</span>
    </button>
  );
}

export function ConnectionListPart({ part, latency }: ConnectionListPartProps) {
  const navigate = useNavigate();
  const { org } = useProjectContext();
  const state = getEffectiveState(part.state);
  const result = unwrapResult<{ items?: ConnectionEntity[] }>(part.output);
  // Exclude VIRTUAL connections (agents) — they have their own card.
  const items = (Array.isArray(result?.items) ? result.items : []).filter(
    (c) => c.connection_type !== "VIRTUAL",
  );

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
        title={
          part.state === "output-denied"
            ? "Connection list unavailable"
            : "Couldn't load connections"
        }
        state="error"
        trailing={<LatencyLabel latency={latency} />}
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
        trailing={<LatencyLabel latency={latency} />}
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
        trailing={<LatencyLabel latency={latency} />}
      />
      <div className="mt-2 flex flex-col gap-1.5">
        {visible.map((connection) => (
          <ConnectionRow key={connection.id} connection={connection} />
        ))}
        {hiddenCount > 0 && (
          <SeeAllRow
            count={items.length}
            noun="connections"
            onClick={() =>
              navigate({
                to: "/$org/settings/connections",
                params: { org: org.slug },
              })
            }
          />
        )}
      </div>
    </>
  );
}
