"use client";

import type { ToolUIPart } from "ai";
import { Suspense, useRef, useState, type MouseEvent } from "react";
import { UserCircle } from "@untitledui/icons";
import type { VirtualMCPEntity } from "@decocms/mesh-sdk/types";
import { AgentAvatar } from "@/web/components/agent-icon";
import { AgentConnectionsPreview } from "@/web/components/connections/agent-connections-preview.tsx";
import { useNavigateToAgent } from "@/web/hooks/use-navigate-to-agent";
import { formatDuration } from "@/web/lib/format-time.ts";
import { Button } from "@deco/ui/components/button.tsx";
import { ToolCallShell } from "./common.tsx";
import { getEffectiveState } from "./utils.tsx";

interface AgentCreatePartProps {
  part: ToolUIPart;
  latency?: number;
}

// Passport certification text — repeated to fill the card background.
const PASSPORT_TEXT =
  "This document certifies that the bearer agent has been granted authorized access to the tools and capabilities described herein. The agent is permitted to operate within the scope defined by its instructions and shall act in accordance with the constraints set forth by the issuing organization. This credential remains valid for the duration of the agent's active status. Unauthorized modification of this agent's permissions or scope is prohibited. The issuing authority reserves the right to revoke access at any time. All actions performed by this agent are subject to audit and review by the organization administrator. ";

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

export function AgentCreatePart({ part, latency }: AgentCreatePartProps) {
  const navigateToAgent = useNavigateToAgent();
  const state = getEffectiveState(part.state);
  const cardRef = useRef<HTMLDivElement>(null);
  const [ptr, setPtr] = useState({ x: 50, y: 50, active: false });

  const handleMouseMove = (e: MouseEvent<HTMLDivElement>) => {
    const el = cardRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPtr({
      x: ((e.clientX - rect.left) / rect.width) * 100,
      y: ((e.clientY - rect.top) / rect.height) * 100,
      active: true,
    });
  };

  const handleMouseLeave = () => setPtr({ x: 50, y: 50, active: false });

  const latencyLabel =
    latency != null && latency > 0 ? (
      <span className="text-[11px] font-mono tabular-nums text-muted-foreground">
        {formatDuration(latency)}
      </span>
    ) : null;

  if (state === "loading" || state === "approval") {
    return (
      <ToolCallShell
        icon={<UserCircle className="animate-pulse" />}
        title="Creating agent"
        state="loading"
        defaultOpen
      />
    );
  }

  const agent =
    state === "error" || part.state === "output-denied"
      ? undefined
      : unwrapResult<{ item?: VirtualMCPEntity }>(part.output)?.item;

  if (state === "error" || part.state === "output-denied") {
    return (
      <ToolCallShell
        icon={<UserCircle />}
        title={
          part.state === "output-denied"
            ? "Agent creation cancelled"
            : "Couldn't create agent"
        }
        state="error"
        trailing={latencyLabel}
      />
    );
  }

  if (!agent?.id || !agent?.title) {
    return (
      <ToolCallShell
        icon={<UserCircle />}
        title="Agent created"
        state="idle"
        trailing={latencyLabel}
      />
    );
  }

  const connectionIds = (agent.connections ?? []).map((c) => c.connection_id);

  return (
    <>
      <ToolCallShell
        icon={<UserCircle className="text-emerald-500" />}
        title={`Agent created: ${agent.title}`}
        state="idle"
        trailing={latencyLabel}
      />
      <div className="mt-2 overflow-hidden rounded-xl border-[0.5px] border-border bg-card p-2.5">
        <div
          ref={cardRef}
          className="relative overflow-hidden rounded-lg bg-accent/25 p-2"
          style={{
            transition: "transform 0.3s ease-out",
            transform: ptr.active
              ? `perspective(800px) rotateY(${(ptr.x - 50) * 0.05}deg) rotateX(${(ptr.y - 50) * -0.05}deg)`
              : "none",
            willChange: "transform",
          }}
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
        >
          {/* Holographic diagonal gradient — subtle at rest, parallax on hover. */}
          <div
            className="pointer-events-none absolute inset-[-20%] z-[1] select-none rounded-lg"
            style={{
              background:
                "linear-gradient(135deg, hsla(280, 60%, 80%, 0.35) 0%, transparent 35%), linear-gradient(315deg, hsla(190, 70%, 80%, 0.35) 0%, transparent 35%), linear-gradient(225deg, hsla(140, 55%, 80%, 0.3) 0%, transparent 30%), linear-gradient(45deg, hsla(320, 55%, 82%, 0.3) 0%, transparent 30%)",
              opacity: ptr.active ? 1 : 0.4,
              transform: ptr.active
                ? `translate(${(ptr.x - 50) * 0.15}px, ${(ptr.y - 50) * 0.15}px)`
                : "translate(0, 0)",
              transition: "opacity 0.3s ease, transform 0.3s ease-out",
            }}
            aria-hidden="true"
          />

          {/* Passport certification text overlay */}
          <p
            className="pointer-events-none absolute inset-0 z-[1] select-none overflow-hidden text-[6px] font-light leading-[1.5] tracking-[0.06px] text-background opacity-50 mix-blend-overlay"
            style={{ textAlign: "justify", wordBreak: "break-all" }}
            aria-hidden="true"
          >
            {PASSPORT_TEXT.repeat(6)}
          </p>

          {/* Certified agent stamp */}
          <img
            src="/stamp.svg"
            alt=""
            className="pointer-events-none absolute -right-10 -top-10 size-[140px] opacity-50 select-none"
            aria-hidden="true"
          />

          {/* Guilloche patterns — edge to edge, slightly brighter on hover */}
          <img
            src="/left-guilloche.png"
            alt=""
            className="pointer-events-none absolute inset-y-0 left-0 h-full w-auto select-none z-[1] mix-blend-overlay"
            style={{
              opacity: ptr.active ? 0.45 : 0.3,
              transition: "opacity 0.3s ease",
            }}
            aria-hidden="true"
          />
          <img
            src="/right-guilloche.png"
            alt=""
            className="pointer-events-none absolute inset-y-0 right-0 h-full w-auto select-none z-[1] mix-blend-overlay"
            style={{
              opacity: ptr.active ? 0.45 : 0.3,
              transition: "opacity 0.3s ease",
            }}
            aria-hidden="true"
          />

          {/* Content — agent info */}
          <div className="relative">
            <div className="flex items-center gap-2.5 p-2">
              <AgentAvatar icon={agent.icon} name={agent.title} size="md" />
              <div className="flex-1 min-w-0">
                <h3 className="text-sm font-medium text-foreground truncate">
                  {agent.title}
                </h3>
              </div>
            </div>

            {agent.description && (
              <div className="px-2 pt-1 pr-16">
                <p className="text-sm leading-snug text-muted-foreground line-clamp-2">
                  {agent.description}
                </p>
              </div>
            )}
          </div>

          {/* Footer: connections left, action right */}
          <div className="relative z-[3] flex items-center gap-2.5 px-2 pt-6 pb-1">
            <div className="flex-1 min-w-0">
              {connectionIds.length > 0 && (
                <Suspense
                  fallback={<AgentConnectionsPreview.Fallback iconSize="sm" />}
                >
                  <AgentConnectionsPreview
                    connectionIds={connectionIds}
                    iconSize="xs"
                    maxVisibleIcons={3}
                    className="flex items-center justify-start -space-x-1"
                  />
                </Suspense>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Button
                size="sm"
                className="h-7"
                onClick={() => navigateToAgent(agent.id)}
              >
                See agent
              </Button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
