import { IntegrationIcon } from "@/web/components/integration-icon";
import { ConnectSlotRow } from "@/web/components/chat/connect-slot-row";
import { useSlotAppDisplays } from "@/web/hooks/use-slot-app-displays";
import type { SlotLike } from "@/web/hooks/unresolved-slots";

/**
 * Shown when the current user is missing one or more of the agent's required
 * personal connections (typed slots). Each row shows the app's registry icon +
 * friendly name and a Connect button: registry apps connect inline (OAuth in
 * place); synthetic / unknown apps deep-link to the Connections page. When the
 * last slot resolves, the surrounding view re-resolves and replaces this gate.
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
  const displays = useSlotAppDisplays(slots);

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
          <ConnectSlotRow
            key={slot.slot_app_id}
            display={
              displays[slot.slot_app_id] ?? {
                kind: "fallback",
                title: slot.slot_app_id,
                icon: null,
                registryItem: null,
              }
            }
            orgSlug={orgSlug}
          />
        ))}
      </div>
    </div>
  );
}
