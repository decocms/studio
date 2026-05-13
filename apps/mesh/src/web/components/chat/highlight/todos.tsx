/**
 * TodosHighlight — persistent collapsed chip + click-to-expand panel for the
 * per-thread todo list maintained by the model via `todo_write`.
 *
 * Lives inside `ChatHighlight`, rendered alongside (but visually below) the
 * priority banner stack. Reads the same UIMessage stream the chat renders;
 * no API call of its own.
 *
 * Auto-collapse on banner fire: a `useEffect` watches the `bannerActive`
 * prop and clears local `expanded` state when it flips true. The render
 * also guards against showing the panel while a banner is active, which
 * avoids a one-frame flash before the effect runs.
 *
 * Replaces the deleted `TodosPanel` / `TodosColumn` pair.
 */

import { useEffect, useState } from "react";
import { cn } from "@deco/ui/lib/utils.ts";
import { ChevronDown, ChevronUp } from "@untitledui/icons";
import type { Todo } from "@/api/routes/decopilot/built-in-tools/todo-write";
import { getCurrentTodos } from "@/api/routes/decopilot/current-todos";
import { useChatStream } from "../context";
import { type ChipIcon, deriveChipLabel } from "./derive-chip-label";

interface TodosHighlightProps {
  bannerActive: boolean;
}

export function TodosHighlight({ bannerActive }: TodosHighlightProps) {
  const { messages } = useChatStream();
  const todos = getCurrentTodos(messages);
  const [expanded, setExpanded] = useState(false);

  // oxlint-disable-next-line ban-use-effect/ban-use-effect — collapses the expanded panel when a higher-priority banner fires; one-shot state reset on prop transition has no derived-state equivalent
  useEffect(() => {
    if (bannerActive) setExpanded(false);
  }, [bannerActive]);

  if (todos.length === 0) return null;

  const label = deriveChipLabel(todos);
  const showPanel = expanded && !bannerActive;

  return (
    <div className="px-0.5">
      <div
        className={cn(
          "mb-2 rounded-lg border border-dashed bg-background shadow",
          "overflow-hidden",
        )}
      >
        <button
          type="button"
          data-testid="todos-chip"
          aria-expanded={showPanel}
          onClick={() => setExpanded((prev) => !prev)}
          className={cn(
            "flex items-center gap-2 w-full px-3 py-2 text-sm text-left",
            "hover:bg-accent/50 transition-colors",
            showPanel && "border-b border-dashed",
          )}
        >
          <StatusMark status={label.icon} />
          <span className="flex-1 min-w-0 truncate">{label.activity}</span>
          <span className="text-xs text-muted-foreground shrink-0">
            {label.progress}
          </span>
          <span aria-hidden="true" className="text-muted-foreground shrink-0">
            {showPanel ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </span>
        </button>
        {showPanel ? (
          <ul
            data-testid="todos-expanded-panel"
            className="flex flex-col gap-1.5 px-3 py-2.5 max-h-[40vh] overflow-y-auto"
          >
            {/* key=i is safe: todo_write rewrites the full list atomically; no stable id exists */}
            {todos.map((todo, i) => (
              <TodoRow key={i} todo={todo} />
            ))}
          </ul>
        ) : null}
      </div>
    </div>
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
