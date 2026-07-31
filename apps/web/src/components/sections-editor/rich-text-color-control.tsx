import { useState } from "react";
import { Palette } from "@untitledui/icons";
import type { Editor } from "@tiptap/core";
import { cn } from "@deco/ui/lib/utils.js";
import { useT } from "@/i18n/use-t.ts";
import { ToolbarButton } from "./rich-text-link-control";

/**
 * Preset text colors offered as swatches. These are *content* colors the
 * author applies to their copy (arbitrary hex is intentional here), not UI
 * chrome — so they are raw values, not design-system tokens.
 */
const PRESET_COLORS = [
  "#000000",
  "#525252",
  "#a3a3a3",
  "#ffffff",
  "#e11d48",
  "#ea580c",
  "#ca8a04",
  "#16a34a",
  "#0891b2",
  "#2563eb",
  "#7c3aed",
  "#db2777",
] as const;

/**
 * Text-color toolbar button with a popover of preset swatches, a native color
 * input for custom values, and a "default" option that clears the color mark.
 * The parent owns `open` so the toolbar stays visible while the popover holds
 * focus (the editor is blurred at that point), mirroring the link control.
 */
export function RichTextColorControl({
  editor,
  currentColor,
  open,
  onOpenChange,
}: {
  editor: Editor;
  currentColor: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const [custom, setCustom] = useState(currentColor ?? "#000000");
  // Resync the custom swatch to the actually-applied color whenever the
  // popover opens, so canceling the native color dialog without picking a
  // new value re-applies the same color instead of clobbering it with a
  // stale "custom" state from a previous session (e.g. a preset pick).
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setCustom(currentColor ?? "#000000");
  }

  const applyColor = (color: string) => {
    editor.chain().focus().setColor(color).run();
    onOpenChange(false);
  };

  const clearColor = () => {
    editor.chain().focus().unsetColor().run();
    onOpenChange(false);
  };

  return (
    <div className="relative">
      <ToolbarButton
        active={open || currentColor !== null}
        label={t("sectionsEditor.richTextColorControl.colorButtonLabel")}
        onClick={() => onOpenChange(!open)}
      >
        <span className="relative flex flex-col items-center">
          <Palette size={14} />
          <span
            className="mt-0.5 h-0.5 w-3.5 rounded-full"
            style={{ backgroundColor: currentColor ?? "currentColor" }}
          />
        </span>
      </ToolbarButton>
      {open && (
        <div
          tabIndex={-1}
          className="absolute left-0 top-full z-20 mt-1.5 flex w-56 flex-col gap-2 rounded-md border bg-popover p-2 shadow-md"
          onBlur={(e) => {
            // Close when focus leaves the popover entirely (toolbar buttons
            // preventDefault on mousedown, so they never steal focus).
            if (!e.currentTarget.contains(e.relatedTarget)) {
              onOpenChange(false);
            }
          }}
        >
          <div className="grid grid-cols-6 gap-1">
            {PRESET_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                aria-label={color}
                aria-pressed={currentColor === color}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => applyColor(color)}
                className={cn(
                  "h-6 w-6 rounded border border-border/60 transition-transform cursor-pointer hover:scale-110",
                  currentColor === color && "ring-2 ring-ring ring-offset-1",
                )}
                style={{ backgroundColor: color }}
              />
            ))}
          </div>
          <div className="flex items-center gap-1">
            <label className="flex flex-1 items-center gap-1.5 rounded bg-muted/40 px-2 py-1 text-xs text-muted-foreground cursor-pointer">
              <input
                type="color"
                value={custom}
                onMouseDown={(e) => e.stopPropagation()}
                onChange={(e) => setCustom(e.target.value)}
                onBlur={() => applyColor(custom)}
                className="h-5 w-5 cursor-pointer rounded border-0 bg-transparent p-0"
              />
              {t("sectionsEditor.richTextColorControl.customLabel")}
            </label>
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={clearColor}
              className="rounded px-2 py-1 text-xs text-muted-foreground transition-colors cursor-pointer hover:bg-muted hover:text-foreground"
            >
              {t("sectionsEditor.richTextColorControl.defaultLabel")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
