/**
 * TodosPanel — read-only sidebar for the per-thread todo list maintained
 * by the model via the `todo_write` tool. Derives state from the same
 * UIMessage stream the chat renders; no API call of its own.
 *
 * Distinct from the org-wide `TasksPanelColumn` (automations) — these
 * todos are per-thread, ephemeral, and model-managed.
 */

import { cn } from "@deco/ui/lib/utils.ts";
import type { UIMessage } from "ai";
import type { Todo } from "@/api/routes/decopilot/built-in-tools/todo-write";
import { getCurrentTodos } from "@/api/routes/decopilot/current-todos";

interface TodosPanelProps {
  messages: readonly UIMessage[];
}

export function TodosPanel({ messages }: TodosPanelProps) {
  const todos = getCurrentTodos(messages);
  if (todos.length === 0) return null;

  return (
    <aside
      data-testid="todos-panel"
      className="h-full flex flex-col gap-2 p-3 bg-background"
    >
      <header className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
        Todos
      </header>
      <ul className="flex flex-col gap-1.5">
        {todos.map((todo, i) => (
          <TodoRow key={i} todo={todo} />
        ))}
      </ul>
    </aside>
  );
}

function TodoRow({ todo }: { todo: Todo }) {
  const isCompleted = todo.status === "completed";
  const isInProgress = todo.status === "in_progress";
  const label = isInProgress ? todo.activeForm : todo.content;

  return (
    <li
      className={cn(
        "flex items-start gap-2 text-sm",
        isCompleted && "text-muted-foreground line-through opacity-70",
      )}
    >
      <StatusMark status={todo.status} />
      <span className="leading-snug">{label}</span>
    </li>
  );
}

function StatusMark({ status }: { status: Todo["status"] }) {
  if (status === "completed") {
    return (
      <span aria-label="completed" className="mt-0.5">
        ✓
      </span>
    );
  }
  if (status === "in_progress") {
    return (
      <span
        aria-label="in progress"
        className="mt-0.5 inline-block w-2 h-2 rounded-full bg-primary animate-pulse"
      />
    );
  }
  return (
    <span
      aria-label="pending"
      className="mt-0.5 inline-block w-2 h-2 rounded-full border border-muted-foreground"
    />
  );
}
