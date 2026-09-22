import { NOTIFICATION_READ_EVENT } from "@decocms/shared/notification-types";
import { sseHub } from "@/event-bus/sse-hub";

export function emitNotificationsRead(organizationId: string, userId: string) {
  sseHub.emit(organizationId, {
    id: crypto.randomUUID(),
    type: NOTIFICATION_READ_EVENT,
    source: "notifications",
    subject: userId,
    time: new Date().toISOString(),
  });
}
