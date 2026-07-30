import { useState } from "react";
import type { Editor } from "@tiptap/core";
import { Check, Link01, Trash01 } from "@untitledui/icons";
import { cn } from "@deco/ui/lib/utils.ts";
import { useT } from "@/i18n/use-t.ts";
import {
  isSafeLinkUrl,
  normalizeLinkUrl,
} from "../sections-editor/rich-text-link-validation";
import { ToolbarButton } from "../sections-editor/rich-text-link-control";

/**
 * Inline link editor for the bubble toolbar. Deliberately narrower than the
 * sections-editor control: markdown links carry no `target`, so offering a
 * same-tab / new-tab choice here would silently drop on save.
 */
export function LinkPopover({ editor }: { editor: Editor }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [invalid, setInvalid] = useState(false);
  const active = editor.isActive("link");

  const toggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    const href = editor.getAttributes("link").href;
    setDraft(typeof href === "string" ? href : "");
    setInvalid(false);
    setOpen(true);
  };

  const remove = () => {
    editor.chain().focus().extendMarkRange("link").unsetLink().run();
    setOpen(false);
  };

  const apply = () => {
    const url = normalizeLinkUrl(draft);
    if (url === "") {
      remove();
      return;
    }
    if (!isSafeLinkUrl(url)) {
      setInvalid(true);
      return;
    }
    editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
    setOpen(false);
  };

  return (
    <div className="relative">
      <ToolbarButton
        active={active}
        label={t("markdownEditor.link")}
        onClick={toggle}
      >
        <Link01 size={14} />
      </ToolbarButton>
      {open && (
        <div
          className="absolute left-0 top-full z-20 mt-1.5 flex w-64 items-center gap-0.5 rounded-md border bg-popover p-1 shadow-md"
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false);
          }}
        >
          <input
            // oxlint-disable-next-line no-autofocus -- the popover only opens on explicit user action; focus must move to the URL input
            autoFocus
            type="text"
            aria-label={t("markdownEditor.linkInputAriaLabel")}
            aria-invalid={invalid}
            placeholder={t("markdownEditor.linkPlaceholder")}
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
                setOpen(false);
                editor.chain().focus().run();
              }
            }}
            className={cn(
              "h-7 min-w-0 flex-1 rounded bg-transparent px-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none",
              invalid && "text-destructive",
            )}
          />
          <ToolbarButton
            active={false}
            label={t("markdownEditor.linkApply")}
            onClick={apply}
          >
            <Check size={14} />
          </ToolbarButton>
          {active && (
            <ToolbarButton
              active={false}
              label={t("markdownEditor.linkRemove")}
              onClick={remove}
            >
              <Trash01 size={14} />
            </ToolbarButton>
          )}
        </div>
      )}
    </div>
  );
}
