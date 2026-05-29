import { Link } from "@tanstack/react-router";
import { Button } from "@deco/ui/components/button.tsx";
import { IntegrationIcon } from "@/web/components/integration-icon";
import type { SlotLike } from "@/web/hooks/unresolved-slots";

/**
 * Shown in the chat pane when the current user is missing one or more of the
 * agent's required personal connections (typed slots). Lists each missing
 * connection with a Connect link to the Connections page. No composer is
 * rendered alongside this (the agent can't run until the slots are filled).
 */
export function ConnectAgentGate({
  agentTitle,
  agentIcon,
  slots,
  orgSlug,
}: {
  agentTitle: string;
  agentIcon: string | null;
  slots: SlotLike[];
  orgSlug: string;
}) {
  return (
    <div className="h-full w-full flex flex-col items-center justify-center gap-6 px-4">
      <div className="flex flex-col items-center justify-center gap-3 text-center max-w-md">
        <IntegrationIcon
          icon={agentIcon}
          name={agentTitle}
          size="lg"
          className="size-12 min-w-12 rounded-xl"
        />
        <h3 className="text-base md:text-xl font-medium text-foreground">
          Connect to use this agent
        </h3>
        <p className="text-muted-foreground text-sm">
          "{agentTitle}" needs your personal connections before it can run.
        </p>
      </div>
      <div className="w-full max-w-sm flex flex-col gap-2">
        {slots.map((slot) => (
          <div
            key={slot.slot_app_id}
            className="flex items-center gap-3 rounded-xl border border-border px-4 py-3"
          >
            <IntegrationIcon
              icon={null}
              name={slot.slot_app_id}
              size="sm"
              className="shrink-0"
            />
            <span className="flex-1 min-w-0 text-sm font-medium truncate">
              {slot.slot_app_id}
            </span>
            <Button
              asChild
              variant="outline"
              size="sm"
              className="h-7 text-xs shrink-0"
            >
              <Link to="/$org/settings/connections" params={{ org: orgSlug }}>
                Connect
              </Link>
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}
