import { Suspense } from "react";
import { Button } from "@deco/ui/components/button.tsx";
import { useProjectContext } from "@decocms/mesh-sdk";
import { ConnectSlotRow } from "@/web/components/chat/connect-slot-row";
import { useOptionalChatStream } from "@/web/components/chat/chat-context";
import { useSlotAppDisplays } from "@/web/hooks/use-slot-app-displays";

interface ConnectCardData {
  agentId: string;
  agentTitle: string;
  appIds: string[];
}

/**
 * Visible connect card rendered inline in the assistant message when an agent
 * (parent or a delegated subagent) couldn't resolve its typed slots for the
 * current user. Shows one Connect row per missing app and a Retry button that
 * re-runs the last user turn once the connections are in place.
 */
export function ConnectCard({ data }: { data: ConnectCardData }) {
  return (
    <Suspense fallback={<ConnectCardFallback data={data} />}>
      <ConnectCardInner data={data} />
    </Suspense>
  );
}

function ConnectCardFallback({ data }: { data: ConnectCardData }) {
  return (
    <div className="rounded-xl border border-border p-4 my-1.5">
      <p className="text-sm font-medium">Connect to use "{data.agentTitle}"</p>
      <p className="text-xs text-muted-foreground">Loading connections…</p>
    </div>
  );
}

function ConnectCardInner({ data }: { data: ConnectCardData }) {
  const { org } = useProjectContext();
  const stream = useOptionalChatStream();
  const slots = data.appIds.map((appId) => ({ slot_app_id: appId }));
  const displays = useSlotAppDisplays(slots);

  const handleRetry = () => {
    if (!stream) return;
    const lastUser = [...stream.messages]
      .reverse()
      .find((m) => m.role === "user");
    if (lastUser) void stream.sendMessage({ parts: lastUser.parts });
  };

  return (
    <div className="rounded-xl border border-border p-4 my-1.5 flex flex-col gap-3">
      <div>
        <p className="text-sm font-medium text-foreground">
          Connect to use "{data.agentTitle}"
        </p>
        <p className="text-xs text-muted-foreground">
          This agent needs your personal connections before it can run.
        </p>
      </div>
      <div className="flex flex-col gap-2">
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
            orgSlug={org.slug}
          />
        ))}
      </div>
      {stream ? (
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs self-start"
          onClick={handleRetry}
        >
          Retry
        </Button>
      ) : null}
    </div>
  );
}
