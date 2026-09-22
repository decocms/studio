import { TASK_BOARD_CONVERSATION_UPDATED_EVENT } from "@decocms/shared/task-board";
import { sseHub } from "@/event-bus/sse-hub";

export function emitTaskConversationUpdated(
  organizationId: string,
  itemId: string,
  userId?: string,
) {
  sseHub.emit(organizationId, {
    id: crypto.randomUUID(),
    type: TASK_BOARD_CONVERSATION_UPDATED_EVENT,
    source: "task-board",
    subject: userId,
    time: new Date().toISOString(),
    data: { id: itemId },
  });
}
