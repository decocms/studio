/**
 * TodosColumn — fixed-width right column hosting the per-thread TodosPanel.
 *
 * Mounted inside `Chat.ActiveTaskProvider`, as a sibling of
 * `ChatMainPanelGroup` (see agent-shell-layout/index.tsx). Auto-hides
 * when there are no todos in the loaded message window — a fresh thread
 * shows nothing until the model first calls `todo_write`.
 *
 * Distinct from the org-wide `TasksPanelColumn` (automations) — those
 * are org-level entities; these todos are per-thread, ephemeral, and
 * model-managed.
 */

import { Suspense } from "react";
import { useChatStream } from "@/web/components/chat/chat-context";
import { TodosPanel } from "@/web/components/chat/todos-panel";
import { getCurrentTodos } from "@/api/routes/decopilot/current-todos";

const TODOS_COLUMN_WIDTH_PX = 280;

function TodosColumnInner() {
  const { messages } = useChatStream();
  const todos = getCurrentTodos(messages);
  if (todos.length === 0) return null;

  return (
    <aside
      className="shrink-0 h-full bg-sidebar pb-1"
      style={{ width: `${TODOS_COLUMN_WIDTH_PX}px` }}
    >
      <div className="h-full p-0.5 pt-0.25">
        <div className="h-full bg-background rounded-[0.75rem] overflow-hidden card-shadow">
          <TodosPanel messages={messages} />
        </div>
      </div>
    </aside>
  );
}

export function TodosColumn() {
  return (
    <Suspense fallback={null}>
      <TodosColumnInner />
    </Suspense>
  );
}
