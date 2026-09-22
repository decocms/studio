import { type ReactNode, useRef, useState } from "react";
import { Check, Link01, Trash01 } from "@untitledui/icons";
import type { Editor } from "@tiptap/core";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useT } from "@/i18n/use-t.ts";
import { isSafeLinkUrl, normalizeLinkUrl } from "./rich-text-link-validation";

/** rel applied to new-tab links (security best practice for target=_blank). */
const NEW_TAB_REL = "noopener noreferrer nofollow";

/**
 * An extra way to pick a link target beyond typing a URL — e.g. "a post" or "a
 * product". `render` gets an `apply(url)` it calls once the user picks; the url
 * is trusted (internal path or catalog PDP), so it is linked as-is.
 */
export interface LinkSource {
  id: string;
  label: string;
  icon?: ReactNode;
  render: (apply: (url: string) => void) => ReactNode;
}

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
        "flex h-7 w-7 items-center justify-center rounded-[var(--studio-control-radius,var(--radius))] transition-colors cursor-pointer",
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
        "flex-1 rounded-[var(--studio-control-radius,var(--radius))] px-2 py-1 text-xs transition-colors cursor-pointer",
        active
          ? "bg-accent text-accent-foreground"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}

/** Source-mode tab (URL / Post / Product), mousedown-safe to keep the popover open. */
function ModeTab({
  active,
  icon,
  label,
  onSelect,
}: {
  active: boolean;
  icon?: ReactNode;
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
        "flex flex-1 items-center justify-center gap-1 rounded-[var(--studio-control-radius,var(--radius))] px-2 py-1 text-xs transition-colors cursor-pointer",
        active
          ? "bg-accent text-accent-foreground"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      {icon}
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
  sources,
}: {
  editor: Editor;
  active: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Extra pick-a-target tabs beyond the URL field (post/product links). */
  sources?: LinkSource[];
}) {
  const t = useT();
  const [draft, setDraft] = useState("");
  const [newTab, setNewTab] = useState(true);
  const [invalid, setInvalid] = useState(false);
  const [mode, setMode] = useState("url");

  const openEditor = () => {
    const attrs = editor.getAttributes("link");
    setDraft(typeof attrs.href === "string" ? attrs.href : "");
    // Reflect an existing link's target; default new links to a new tab.
    setNewTab(active ? attrs.target === "_blank" : true);
    setInvalid(false);
    setMode("url");
    onOpenChange(true);
  };

  const close = () => {
    onOpenChange(false);
    editor.chain().focus().run();
  };

  /**
   * Set the link to `href`. A URL typed by the user is normalized and safety-
   * checked; a `trusted` href from a source (internal path / catalog PDP) is
   * linked as-is so relative paths survive.
   */
  const applyHref = (href: string, trusted = false) => {
    const url = trusted ? href.trim() : normalizeLinkUrl(href);
    if (url === "") {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      onOpenChange(false);
      return;
    }
    if (!trusted && !isSafeLinkUrl(url)) {
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

  const apply = () => applyHref(draft);

  const removeLink = () => {
    editor.chain().focus().extendMarkRange("link").unsetLink().run();
    onOpenChange(false);
  };

  const hasSources = !!sources?.length;
  const activeSource = sources?.find((s) => s.id === mode);
  const popoverRef = useRef<HTMLDivElement>(null);

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
          ref={popoverRef}
          className={cn(
            "absolute left-0 top-full z-20 mt-1.5 flex flex-col gap-1 rounded-[var(--studio-surface-radius,var(--radius-md))] border bg-popover p-1 shadow-md",
            hasSources ? "w-80" : "w-64",
          )}
          onBlur={() => {
            // Deferred so a tab switch (input remount) doesn't close the popover.
            requestAnimationFrame(() => {
              if (!popoverRef.current?.contains(document.activeElement)) {
                onOpenChange(false);
              }
            });
          }}
        >
          {hasSources && (
            <div className="flex items-center gap-0.5 rounded-[var(--studio-control-radius,var(--radius))] bg-muted/40 p-0.5">
              <ModeTab
                active={mode === "url"}
                icon={<Link01 size={12} />}
                label={t("sectionsEditor.richTextLinkControl.tabUrl")}
                onSelect={() => setMode("url")}
              />
              {sources?.map((source) => (
                <ModeTab
                  key={source.id}
                  active={mode === source.id}
                  icon={source.icon}
                  label={source.label}
                  onSelect={() => setMode(source.id)}
                />
              ))}
            </div>
          )}
          {activeSource ? (
            activeSource.render((url) => applyHref(url, true))
          ) : (
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
                  "h-7 flex-1 rounded-[var(--studio-control-radius,var(--radius))] bg-transparent px-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none",
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
                  label={t(
                    "sectionsEditor.richTextLinkControl.removeLinkLabel",
                  )}
                  onClick={removeLink}
                >
                  <Trash01 size={14} />
                </ToolbarButton>
              )}
            </div>
          )}
          <div className="flex items-center gap-0.5 rounded-[var(--studio-control-radius,var(--radius))] bg-muted/40 p-0.5">
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
