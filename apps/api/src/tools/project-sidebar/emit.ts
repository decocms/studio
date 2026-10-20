import { PROJECT_FOLDERS_UPDATED_EVENT } from "@decocms/shared/project-sidebar";
import { sseHub } from "@/event-bus/sse-hub";

/** Folders are the same for every member, so a change re-reads everywhere. */
export function emitProjectFoldersUpdated(orgId: string): void {
  sseHub.emit(orgId, {
    id: crypto.randomUUID(),
    type: PROJECT_FOLDERS_UPDATED_EVENT,
    source: "project-sidebar",
    subject: orgId,
    data: {},
    time: new Date().toISOString(),
  });
}
