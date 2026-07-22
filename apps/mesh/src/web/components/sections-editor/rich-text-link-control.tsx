import { useState } from "react";
import { Check, Link01, Trash01 } from "@untitledui/icons";
import type { Editor } from "@tiptap/core";
import { cn } from "@deco/ui/lib/utils.js";
import { useT } from "@/web/i18n/use-t.ts";
import { isSafeLinkUrl, normalizeLinkUrl } from "./rich-text-link-validation";

/** rel applied to new-tab links (security best practice for target=_blank). */
const NEW_TAB_REL = "noopener noreferrer nofollow";

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

/** Segmented "Same tab / New tab" choice — mousedown-safe so it keeps the popover open. */
function TabChoice({
  active,
  label,
  onSelect,
}: {
  active: boolean;
  label: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onSelect}
      className={cn(
        "flex-1 rounded px-2 py-1 text-xs transition-colors cursor-pointer",
        active
          ? "bg-accent text-accent-foreground"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}

/**
 * Link toolbar button with an inline URL editor (no browser prompt) and a
 * same-tab / new-tab choice that sets the anchor's `target`. The parent owns
 * `open` so it can keep its toolbar visible while the URL input holds focus
 * (the editor itself is blurred at that point).
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
  const t = useT();
  const [draft, setDraft] = useState("");
  const [newTab, setNewTab] = useState(true);
  const [invalid, setInvalid] = useState(false);

  const openEditor = () => {
    const attrs = editor.getAttributes("link");
    setDraft(typeof attrs.href === "string" ? attrs.href : "");
    // Reflect an existing link's target; default new links to a new tab.
    setNewTab(active ? attrs.target === "_blank" : true);
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
    editor
      .chain()
      .focus()
      .extendMarkRange("link")
      .setLink({
        href: url,
        target: newTab ? "_blank" : null,
        rel: newTab ? NEW_TAB_REL : null,
      })
      .run();
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
        label={t("sectionsEditor.richTextLinkControl.linkButtonLabel")}
        onClick={open ? close : openEditor}
      >
        <Link01 size={14} />
      </ToolbarButton>
      {open && (
        <div
          className="absolute left-0 top-full z-20 mt-1.5 flex w-64 flex-col gap-1 rounded-md border bg-popover p-1 shadow-md"
          onBlur={(e) => {
            // Close when focus leaves the popover entirely (toolbar buttons
            // preventDefault on mousedown, so they never steal focus).
            if (!e.currentTarget.contains(e.relatedTarget)) {
              onOpenChange(false);
            }
          }}
        >
          <div className="flex items-center gap-0.5">
            <input
              // oxlint-disable-next-line no-autofocus -- the popover only opens on explicit user action; focus must move to the URL input
              autoFocus
              type="text"
              aria-label={t(
                "sectionsEditor.richTextLinkControl.urlInputAriaLabel",
              )}
              aria-invalid={invalid}
              placeholder={t(
                "sectionsEditor.richTextLinkControl.urlInputPlaceholder",
              )}
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
                "h-7 flex-1 rounded bg-transparent px-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none",
                invalid && "text-destructive",
              )}
            />
            <ToolbarButton
              active={false}
              label={t("sectionsEditor.richTextLinkControl.applyLinkLabel")}
              onClick={apply}
            >
              <Check size={14} />
            </ToolbarButton>
            {active && (
              <ToolbarButton
                active={false}
                label={t("sectionsEditor.richTextLinkControl.removeLinkLabel")}
                onClick={removeLink}
              >
                <Trash01 size={14} />
              </ToolbarButton>
            )}
          </div>
          <div className="flex items-center gap-0.5 rounded bg-muted/40 p-0.5">
            <TabChoice
              active={!newTab}
              label={t("sectionsEditor.richTextLinkControl.sameTabLabel")}
              onSelect={() => setNewTab(false)}
            />
            <TabChoice
              active={newTab}
              label={t("sectionsEditor.richTextLinkControl.newTabLabel")}
              onSelect={() => setNewTab(true)}
            />
          </div>
        </div>
      )}
    </div>
  );
}
