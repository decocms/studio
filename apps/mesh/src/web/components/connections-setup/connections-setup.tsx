import { useState, useRef } from "react";
import { SlotCard } from "./slot-card";
import type { ConnectionSlot } from "./use-slot-resolution";

export interface ConnectionsSetupProps {
  slots: Record<string, ConnectionSlot>;
  onComplete: (connections: Record<string, string>) => void;
}

export function ConnectionsSetup({ slots, onComplete }: ConnectionsSetupProps) {
  const [completed, setCompleted] = useState<Record<string, string>>({});
  const wasAllDoneRef = useRef(false);

  const handleSlotComplete = (slotId: string, connectionId: string) => {
    setCompleted((prev) => {
      const next = { ...prev };
      if (connectionId === "") {
        delete next[slotId];
      } else {
        next[slotId] = connectionId;
      }
      return next;
    });
  };

  const allSlotIds = Object.keys(slots);
  const allDone =
    allSlotIds.length > 0 && allSlotIds.every((id) => completed[id]);

  if (allDone && !wasAllDoneRef.current) {
    wasAllDoneRef.current = true;
    onComplete(completed);
  } else if (!allDone) {
    wasAllDoneRef.current = false;
  }

  return (
    <div className="space-y-3">
      {Object.entries(slots).map(([slotId, slot]) => (
        <SlotCard
          key={slotId}
          slot={slot}
          onComplete={(connectionId) =>
            handleSlotComplete(slotId, connectionId)
          }
        />
      ))}
    </div>
  );
}
