/**
 * Develop/Live toggle rendered in the agent shell header — shown ONLY when the
 * agent is part of a dev/live pair. Clicking the inactive side opens a fresh
 * task on the linked counterpart; the dev agent is hidden from the sidebar, so
 * this toggle is the way to it. Setting up / linking a dev agent lives in the
 * agent settings (see DevAgentSetup), not here.
 */

import { cn } from "@deco/ui/lib/utils.ts";
import { Code01, Globe01 } from "@untitledui/icons";
import type { ComponentType } from "react";
import { useVirtualMCPs } from "@/sdk";
import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import { useChatNavigation } from "@/components/chat/hooks/use-chat-navigation";
import { useThreadActions } from "@/components/chat/store/hooks";
import { findDevPartner } from "@/lib/agent-capabilities";

export function DevAgentControl({
  virtualMcp,
}: {
  virtualMcp: VirtualMCPEntity;
}) {
  const allAgents = useVirtualMCPs();
  const { navigateToTask } = useChatNavigation();
  const { create } = useThreadActions();

  const partner = findDevPartner(virtualMcp, allAgents);
  if (!partner) return null;

  const isDev = partner.mode === "dev";

  /** Open a fresh task on the paired counterpart. `navigateToTask` carries
   *  `?main`/`?chat`, so a same-id tab stays selected across the flip. */
  const goToAgent = async (agentId: string) => {
    const taskId = crypto.randomUUID();
    try {
      await create({ id: taskId, virtual_mcp_id: agentId });
    } catch {
      // The action already toasted; navigate anyway so the route loader's
      // ensure-fallback retries the thread create.
    }
    navigateToTask(taskId, { virtualMcpId: agentId });
  };

  // Below `lg` (< 1024px) the segments collapse to icon-only; the label moves to
  // the native title tooltip (kept as `aria-label` for a11y either way).
  const segment = (
    label: string,
    active: boolean,
    Icon: ComponentType<{ className?: string }>,
  ) => (
    <button
      type="button"
      aria-pressed={active}
      aria-label={label}
      title={label}
      onClick={() => {
        if (!active) void goToAgent(partner.targetId);
      }}
      className={cn(
        "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md transition-colors",
        active
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      <Icon className="size-3.5 shrink-0" />
      {/* Collapses with the rest of the strip at 768px of panel header. */}
      <span className="@max-3xl/panel-header:hidden">{label}</span>
    </button>
  );

  return (
    <div className="inline-flex items-center rounded-lg border border-border bg-muted p-0.5 text-xs font-medium">
      {segment("Develop", isDev, Code01)}
      {segment("Live", !isDev, Globe01)}
    </div>
  );
}
