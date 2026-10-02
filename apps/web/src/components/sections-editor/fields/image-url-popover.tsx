import { useState } from "react";
import { Input } from "@decocms/ui/components/input.tsx";
import { useT } from "@/i18n/use-t.ts";
import { safeImageSrc } from "./safe-image-url";

/**
 * The "paste an address" panel behind an image field's link button.
 *
 * It owns the draft and hands its parent only a committed, sanitized value —
 * the text being typed never leaves this component. That boundary is the
 * point: a field bound straight to a preview means every half-typed address
 * is already the `<img src>`, and a check at the sink does not undo that.
 *
 * Enter and blur commit; Escape reverts. An address on a scheme that must
 * never reach a `src` is refused with a message instead of stored, so it
 * cannot reach the decofile — and therefore the site — either.
 */
export function ImageUrlPopover({
  value,
  label,
  onCommit,
  onDone,
}: {
  /** The committed URL this panel is editing. */
  value: string;
  /** Names the slot being edited — desktop or mobile. */
  label: string;
  onCommit: (next: string | undefined) => void;
  /** Called when a commit succeeds or the author cancels. */
  onDone: () => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState(value);
  const [notice, setNotice] = useState<string | null>(null);
  // Re-seed when the slot changes under the open panel.
  const [seen, setSeen] = useState(value);
  if (seen !== value) {
    setSeen(value);
    setDraft(value);
    setNotice(null);
  }

  const commit = () => {
    const next = safeImageSrc(draft);
    if (!next && draft.trim()) {
      setNotice(t("sectionsEditor.imageField.unsafeUrl"));
      return false;
    }
    setNotice(null);
    if (next !== value) onCommit(next || undefined);
    return true;
  };

  return (
    <div className="absolute left-0 top-full z-20 mt-1.5 w-96 rounded-[var(--studio-surface-radius,var(--radius-md))] border bg-popover p-1 shadow-md">
      <Input
        // oxlint-disable-next-line no-autofocus -- the panel only opens on an explicit click; focus must land on the input to paste into
        autoFocus
        type="url"
        value={draft}
        onChange={(e) => {
          setNotice(null);
          setDraft(e.target.value);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setDraft(value);
            setNotice(null);
            onDone();
          }
          if (e.key === "Enter" && commit()) onDone();
        }}
        placeholder={t("sectionsEditor.imageField.urlPlaceholder")}
        spellCheck={false}
        aria-label={label}
        className="h-8 w-full text-xs"
      />
      {notice && (
        <p className="px-1 pb-0.5 pt-1.5 text-xs text-destructive">{notice}</p>
      )}
    </div>
  );
}
