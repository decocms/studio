import { DEMO_UPDATED_EVENT } from "@decocms/shared/demo";
import {
  createDecopilotStepEvent,
  createDecopilotFinishEvent,
  createDecopilotThreadStatusEvent,
} from "@decocms/shared/sdk";
import { sseHub } from "@/event-bus/sse-hub";

export function emitDemoUpdated(
  orgId: string,
  thread?: { id: string; step: number; completed: boolean },
) {
  if (thread) {
    sseHub.emit(orgId, createDecopilotStepEvent(thread.id, thread.step));
    sseHub.emit(
      orgId,
      createDecopilotThreadStatusEvent(
        thread.id,
        thread.completed ? "completed" : "in_progress",
      ),
    );
    if (thread.completed)
      sseHub.emit(orgId, createDecopilotFinishEvent(thread.id, "completed"));
  }
  sseHub.emit(orgId, {
    id: crypto.randomUUID(),
    type: DEMO_UPDATED_EVENT,
    source: "demo",
    subject: orgId,
    time: new Date().toISOString(),
    data: {},
  });
}
