import { useState } from "react";
import { Check, Link01, Trash01 } from "@untitledui/icons";
import type { Editor } from "@tiptap/core";
import { cn } from "@deco/ui/lib/utils.js";
import { isSafeLinkUrl, normalizeLinkUrl } from "./rich-text-link-validation";

export function ToolbarButton({
  active,
  label,
  onClick,
  children,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      // Keep the editor selection while clicking the toolbar.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn(
        "flex h-7 w-7 items-center justify-center rounded transition-colors cursor-pointer",
        active
          ? "bg-accent text-accent-foreground"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

/**
 * Link toolbar button with an inline URL editor (no browser prompt).
 * The parent owns `open` so it can keep its toolbar visible while the
 * URL input holds focus (the editor itself is blurred at that point).
 */
export function RichTextLinkControl({
  editor,
  active,
  open,
  onOpenChange,
}: {
  editor: Editor;
  active: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [draft, setDraft] = useState("");
  const [invalid, setInvalid] = useState(false);

  const openEditor = () => {
    const prev = editor.getAttributes("link").href as string | undefined;
    setDraft(prev ?? "");
    setInvalid(false);
    onOpenChange(true);
  };

  const close = () => {
    onOpenChange(false);
    editor.chain().focus().run();
  };

  const apply = () => {
    const url = normalizeLinkUrl(draft);
    if (url === "") {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      onOpenChange(false);
      return;
    }
    if (!isSafeLinkUrl(url)) {
      setInvalid(true);
      return;
    }
    editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
    onOpenChange(false);
  };

  const removeLink = () => {
    editor.chain().focus().extendMarkRange("link").unsetLink().run();
    onOpenChange(false);
  };

  return (
    <div className="relative">
      <ToolbarButton
        active={active}
        label="Link"
        onClick={open ? close : openEditor}
      >
        <Link01 size={14} />
      </ToolbarButton>
      {open && (
        <div
          className="absolute left-0 top-full z-20 mt-1.5 flex items-center gap-0.5 rounded-md border bg-popover p-1 shadow-md"
          onBlur={(e) => {
            // Close when focus leaves the popover entirely (toolbar buttons
            // preventDefault on mousedown, so they never steal focus).
            if (!e.currentTarget.contains(e.relatedTarget)) {
              onOpenChange(false);
            }
          }}
        >
          <input
            // oxlint-disable-next-line no-autofocus -- the popover only opens on explicit user action; focus must move to the URL input
            autoFocus
            type="text"
            aria-label="Link URL"
            aria-invalid={invalid}
            placeholder="Paste or type a link…"
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setInvalid(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                apply();
              } else if (e.key === "Escape") {
                e.preventDefault();
                close();
              }
            }}
            className={cn(
              "h-7 w-56 rounded bg-transparent px-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none",
              invalid && "text-destructive",
            )}
          />
          <ToolbarButton active={false} label="Apply link" onClick={apply}>
            <Check size={14} />
          </ToolbarButton>
          {active && (
            <ToolbarButton
              active={false}
              label="Remove link"
              onClick={removeLink}
            >
              <Trash01 size={14} />
            </ToolbarButton>
          )}
        </div>
      )}
    </div>
  );
}
