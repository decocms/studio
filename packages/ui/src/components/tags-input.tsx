import { useControllableState } from "@radix-ui/react-use-controllable-state";
import { X } from "@untitledui/icons";
import { useState } from "react";
import type * as React from "react";

import { cn } from "../lib/utils.ts";
import { Badge } from "./badge.tsx";

const DEFAULT_DELIMITERS = [",", ";", "\n"];
const defaultRemoveLabel = (tag: string) => `Remove ${tag}`;

type TagsInputProps = Omit<
  React.ComponentProps<"input">,
  "value" | "defaultValue" | "onChange"
> & {
  value?: string[];
  defaultValue?: string[];
  onValueChange?: (tags: string[]) => void;
  /** Characters that end a tag while typing or pasting. Enter always does. */
  delimiters?: string[];
  /** False marks a tag as invalid: it stays, painted red, so it can be fixed. */
  validate?: (tag: string) => boolean;
  /** Accessible name of each tag's remove button, translated by the caller. */
  removeLabel?: (tag: string) => string;
};

/** Free text that turns into tags: emails, keywords, labels. */
function TagsInput({
  value: valueProp,
  defaultValue,
  onValueChange,
  delimiters = DEFAULT_DELIMITERS,
  validate,
  removeLabel = defaultRemoveLabel,
  placeholder,
  disabled,
  className,
  onKeyDown: onKeyDownProp,
  onBlur,
  onPaste,
  ...props
}: TagsInputProps) {
  const [tags = [], setTags] = useControllableState({
    prop: valueProp,
    defaultProp: defaultValue ?? [],
    onChange: onValueChange,
  });
  const [draft, setDraft] = useState("");

  const add = (text: string) => {
    const pattern = new RegExp(
      `[${delimiters.map((d) => d.replace(/[\\^\]-]/g, "\\$&")).join("")}]`,
    );
    const next = text
      .split(pattern)
      .map((part) => part.trim())
      .filter((part) => part && !tags.includes(part));
    if (next.length > 0) setTags([...tags, ...new Set(next)]);
  };

  const remove = (tag: string) => setTags(tags.filter((t) => t !== tag));

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    onKeyDownProp?.(event);
    if (event.defaultPrevented) return;
    if (event.key === "Enter" || delimiters.includes(event.key)) {
      if (!draft.trim()) return;
      event.preventDefault();
      add(draft);
      setDraft("");
    } else if (event.key === "Backspace" && !draft && tags.length > 0) {
      remove(tags[tags.length - 1]!);
    }
  };

  return (
    <div
      data-slot="tags-input"
      className={cn(
        "focus-within-ring flex min-h-[var(--studio-control-height,2.25rem)] w-full flex-wrap items-center gap-1 rounded-[var(--studio-control-radius,var(--radius-lg))] bg-[var(--studio-input-background)] px-1.5 py-1.5 text-sm shadow-edge transition-[background-color,box-shadow] hover:bg-sidebar has-[input:disabled]:pointer-events-none has-[input:disabled]:text-subtle-foreground",
        className,
      )}
    >
      {tags.map((tag) => {
        const valid = validate?.(tag) ?? true;
        return (
          <Badge
            key={tag}
            variant={valid ? "outline" : "destructive"}
            size="lg"
            className={cn("bg-card gap-1 pr-1", !valid && "bg-destructive/10")}
          >
            {tag}
            <button
              type="button"
              onClick={() => remove(tag)}
              aria-label={removeLabel(tag)}
              disabled={disabled}
              className="hover:bg-accent focus-ring flex size-4 items-center justify-center rounded-full"
            >
              <X className="size-3" />
            </button>
          </Badge>
        );
      })}
      <input
        data-slot="tags-input-input"
        {...props}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        onBlur={(event) => {
          onBlur?.(event);
          if (draft.trim()) {
            add(draft);
            setDraft("");
          }
        }}
        onPaste={(event) => {
          onPaste?.(event);
          if (event.defaultPrevented) return;
          const text = event.clipboardData.getData("text");
          if (!delimiters.some((d) => text.includes(d))) return;
          event.preventDefault();
          add(text);
        }}
        placeholder={tags.length === 0 ? placeholder : undefined}
        disabled={disabled}
        className="placeholder:text-subtle-foreground min-w-[8ch] flex-1 bg-transparent px-1.5 outline-none"
      />
    </div>
  );
}

export { TagsInput };
export type { TagsInputProps };
