import { cn } from "@deco/ui/lib/utils.js";
import { useState } from "react";
import { useChatStable } from "./context";
import { TypewriterTitle } from "./typewriter-title";

/**
 * Editable task title for chat headers.
 *
 * Display mode: renders TypewriterTitle animation.
 * Click: switches to an input for renaming (text auto-selected for easy copy).
 * Enter/blur: saves if changed. Escape: discards.
 */
export function EditableTaskTitle({
  taskId,
  text,
  className,
}: {
  taskId: string;
  text: string;
  className?: string;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [editingTitle, setEditingTitle] = useState("");
  const { renameTask } = useChatStable();

  const startEditing = () => {
    setEditingTitle(text);
    setIsEditing(true);
  };

  const commitEdit = async () => {
    const trimmed = editingTitle.trim();
    if (trimmed && trimmed !== text) {
      await renameTask(taskId, trimmed);
    }
    setIsEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commitEdit();
    } else if (e.key === "Escape") {
      setIsEditing(false);
    }
  };

  if (isEditing) {
    return (
      <input
        ref={(el) => {
          if (el) {
            el.focus();
            el.select();
          }
        }}
        value={editingTitle}
        onChange={(e) => setEditingTitle(e.target.value)}
        onBlur={() => commitEdit()}
        onKeyDown={handleKeyDown}
        className={cn(
          className,
          "bg-transparent border-b border-foreground/30 focus:border-foreground outline-none pb-0.5 min-w-0",
        )}
      />
    );
  }

  return (
    <button
      type="button"
      onClick={startEditing}
      className={cn(className, "cursor-pointer truncate text-left")}
      title="Click to rename"
    >
      <TypewriterTitle text={text} />
    </button>
  );
}
