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
      icon={<ChipStatusIcon status={label.icon} />}
      label={label.activity}
      count={label.progress}
      defaultExpanded={false}
    >
      <ul
        data-testid="todos-list"
        className="flex flex-col px-2 max-h-[40vh] overflow-y-auto"
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
    <li className="flex items-start gap-2.5 px-2 py-1.5 rounded-lg hover:bg-accent/50 transition-colors">
      <TodoCheckbox status={todo.status} />
      <span
        className={cn(
          "relative text-sm leading-snug pt-px select-none",
          isCompleted && "text-muted-foreground",
        )}
      >
        {label}
        <span
          aria-hidden="true"
          style={{
            position: "absolute",
            left: 0,
            top: "50%",
            height: "1px",
            background: "currentColor",
            width: isCompleted ? "100%" : "0%",
            transition: isCompleted
              ? "width 300ms ease 200ms"
              : "width 150ms ease",
          }}
        />
      </span>
    </li>
  );
}

function TodoCheckbox({ status }: { status: Todo["status"] }) {
  return (
    <div
      className="todo-cb mt-0.5"
      data-checked={status === "completed" ? "true" : undefined}
      data-progress={status === "in_progress" ? "true" : undefined}
      aria-hidden="true"
    >
      <svg viewBox="0 0 21 21">
        <path d="M5,10.75 L8.5,14.25 L19.4,2.3 C18.8333333,1.43333333 18.0333333,1 17,1 L4,1 C2.35,1 1,2.35 1,4 L1,17 C1,18.65 2.35,20 4,20 L17,20 C18.65,20 20,18.65 20,17 L20,7.99769186" />
      </svg>
    </div>
  );
}

function ChipStatusIcon({ status }: { status: ChipIcon }) {
  if (status === "completed") {
    return (
      <span
        aria-label="completed"
        className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-sm bg-primary"
      >
        <svg
          viewBox="0 0 10 8"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="w-2 h-2 text-primary-foreground"
          style={{ strokeWidth: 2 }}
        >
          <path d="M1 4l2.5 2.5L9 1" />
        </svg>
      </span>
    );
  }
  if (status === "in_progress") {
    return (
      <span
        aria-label="in progress"
        className="inline-block w-2 h-2 rounded-full bg-primary animate-pulse shrink-0"
      />
    );
  }
  return (
    <span
      aria-label="pending"
      className="inline-block w-3.5 h-3.5 rounded-sm border-[1.5px] border-muted-foreground/50 shrink-0"
    />
  );
}
