import { Upload01 } from "@untitledui/icons";

/**
 * Hover/focus hint shown over a clickable media preview to signal that clicking
 * it replaces the file. Expects an ancestor with the `group` class (the preview
 * wrapper); reveals on hover and on keyboard focus-within for parity.
 */
export function ClickToReplaceOverlay() {
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
      <span className="flex items-center gap-1.5 rounded-md bg-background px-3 py-1.5 text-xs font-medium shadow">
        <Upload01 size={14} />
        Click to replace
      </span>
    </div>
  );
}
