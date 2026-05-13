/**
 * TodosHighlight — collapsed chip + expanded list for the per-thread todo
 * list maintained by the model via `todo_write`.
 *
 * Reads the same UIMessage stream the chat renders; no API call of its
 * own. Renders nothing when the list is empty.
 *
 * Defaults to collapsed (only banner that does) — todos are passive
 * status, not an active prompt. Wraps `CollapsibleHighlight` so the
 * chip + body share a single card with consistent chrome.
 */

import { cn } from "@deco/ui/lib/utils.ts";
import type { Todo } from "@/api/routes/decopilot/built-in-tools/todo-write";
import { useChatStream } from "../context";
import { CollapsibleHighlight } from "./collapsible-highlight";
import { deriveCurrentTodos } from "./derive-current-todos";
import { type ChipIcon, deriveChipLabel } from "./derive-chip-label";

export function TodosHighlight() {
  const { messages } = useChatStream();
  const todos = deriveCurrentTodos(messages);
  if (todos.length === 0) return null;

  const label = deriveChipLabel(todos);

  return (
    <CollapsibleHighlight
      icon={<StatusMark status={label.icon} />}
      label={label.activity}
      count={label.progress}
      defaultExpanded={false}
    >
      <ul
        data-testid="todos-list"
        className="flex flex-col gap-1.5 px-4 max-h-[40vh] overflow-y-auto"
      >
        {/* key=i is safe: todo_write rewrites the full list atomically; no stable id exists */}
        {todos.map((todo, i) => (
          <TodoRow key={i} todo={todo} />
        ))}
      </ul>
    </CollapsibleHighlight>
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

function StatusMark({ status }: { status: ChipIcon }) {
  if (status === "completed") {
    return (
      <span aria-label="completed" className="mt-0.5 shrink-0">
        ✓
      </span>
    );
  }
  if (status === "in_progress") {
    return (
      <span
        aria-label="in progress"
        className="mt-0.5 inline-block w-2 h-2 rounded-full bg-primary animate-pulse shrink-0"
      />
    );
  }
  return (
    <span
      aria-label="pending"
      className="mt-0.5 inline-block w-2 h-2 rounded-full border border-muted-foreground shrink-0"
    />
  );
}
