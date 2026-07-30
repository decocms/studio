/**
 * Bridges dragging a task board card (dnd-kit, pointer-based, confined to the
 * board's own DndContext) into the chat composer, which lives in a sibling
 * panel outside that context. dnd-kit's drag never fires native DragEvents,
 * so the board hit-tests the dragged card's rect against the element carrying
 * `CHAT_DROP_TARGET_ATTR` and notifies the composer over these window events
 * instead of relying on the browser's own dragenter/dragover/drop.
 */
export const TASK_CHAT_DRAG_OVER_EVENT = "studio:task-chat-drag-over";
export const TASK_CHAT_DROP_EVENT = "studio:task-chat-drop";

/** Marks the chat composer's drop target for the board's hit-testing. */
export const CHAT_DROP_TARGET_ATTR = "data-chat-drop-target";

export interface DraggedTaskPayload {
  id: string;
  title: string;
  description?: string | null;
}

export type TaskChatDragOverEvent = CustomEvent<boolean>;
export type TaskChatDropEvent = CustomEvent<DraggedTaskPayload>;

/** Whether `rect` overlaps the chat composer's drop target, if any is mounted. */
export function isRectOverChatDropTarget(rect: {
  left: number;
  top: number;
  right: number;
  bottom: number;
}): boolean {
  const target = document.querySelector(`[${CHAT_DROP_TARGET_ATTR}]`);
  if (!target) return false;
  const targetRect = target.getBoundingClientRect();
  return (
    rect.left < targetRect.right &&
    rect.right > targetRect.left &&
    rect.top < targetRect.bottom &&
    rect.bottom > targetRect.top
  );
}
