import { Input } from "@decocms/ui/components/input.tsx";

/**
 * The "paste an address" panel behind an image field's link button.
 *
 * Presentational on purpose: the draft and the commit live in the field that
 * opens this, so closing the panel does not destroy what the author typed.
 * The toolbar button that closes it swallows mousedown to hold the editor's
 * selection, so the blur that would otherwise commit never fires — the button
 * would discard exactly what it was opened to collect.
 *
 * Enter and blur commit; Escape reverts. An address on a scheme that must
 * never reach a `src` is refused with a message instead of stored, so it
 * cannot reach the decofile — and therefore the site — either.
 */
export function ImageUrlPopover({
  draft,
  notice,
  label,
  placeholder,
  onDraftChange,
  onCommit,
  onCancel,
}: {
  /** The text being edited, owned by the field. */
  draft: string;
  /** Why the last commit was refused, if it was. */
  notice: string | null;
  /** Names the slot being edited — desktop or mobile. */
  label: string;
  placeholder: string;
  onDraftChange: (next: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="absolute left-0 top-full z-20 mt-1.5 w-96 rounded-[var(--studio-surface-radius,var(--radius-md))] border bg-popover p-1 shadow-md">
      <Input
        // oxlint-disable-next-line no-autofocus -- the panel only opens on an explicit click; focus must land on the input to paste into
        autoFocus
        type="url"
        value={draft}
        onChange={(e) => onDraftChange(e.target.value)}
        onBlur={onCommit}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
          if (e.key === "Enter") onCommit();
        }}
        placeholder={placeholder}
        spellCheck={false}
        aria-label={label}
        className="h-8 w-full text-xs"
      />
      {notice && (
        <p role="alert" className="px-1 pb-0.5 pt-1.5 text-xs text-destructive">
          {notice}
        </p>
      )}
    </div>
  );
}
