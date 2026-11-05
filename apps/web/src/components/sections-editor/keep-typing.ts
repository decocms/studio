/**
 * A conflict dialog opens while the user is still typing: its autosave was
 * refused a moment after the pause that sent it. The dialog takes focus as
 * it opens, so the keystrokes of the word being typed would land on it and
 * be lost ("Probe B more" saved as "Probe B mo").
 *
 * {@link useKeepTyping} hands those keystrokes to the field they were typed
 * into, as if the dialog weren't there: the field's own change runs (the
 * form's value, the dialog's "You (not saved yet)" with it), and focus stays
 * on the dialog. Only the burst that was going on when it opened: it ends at
 * a pause, a key that isn't text (an arrow, Tab, Enter, Escape, a shortcut),
 * a click or tap, or once the field is gone.
 */

import { useEffect, useRef } from "react";

/** A pause in typing longer than this ends the burst. */
export const KEEP_TYPING_GAP_MS = 700;

type TextField = HTMLInputElement | HTMLTextAreaElement;

const TEXT_INPUT_TYPES = new Set(["text", "search", "url", "tel", ""]);

function isTextField(el: Element | null): el is TextField {
  if (!el) return false;
  if (el.tagName === "TEXTAREA") return !(el as HTMLTextAreaElement).readOnly;
  if (el.tagName !== "INPUT") return false;
  const input = el as HTMLInputElement;
  return (
    TEXT_INPUT_TYPES.has(input.type.toLowerCase()) &&
    !input.readOnly &&
    !input.disabled
  );
}

/** Types `key` (a character, or Backspace) into `field` at its caret. */
function typeIntoField(field: TextField, key: string): void {
  const value = field.value;
  const start = field.selectionStart ?? value.length;
  const end = field.selectionEnd ?? start;
  let next: string;
  let caret: number;
  if (key === "Backspace") {
    const from = start === end ? Math.max(0, start - 1) : start;
    next = value.slice(0, from) + value.slice(end);
    caret = from;
  } else {
    next = value.slice(0, start) + key + value.slice(end);
    caret = start + key.length;
  }
  // The prototype's setter, so React sees the change as the user's.
  const setter = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(field),
    "value",
  )?.set;
  if (setter) setter.call(field, next);
  else field.value = next;
  field.setSelectionRange?.(caret, caret);
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

/**
 * While `enabled`, returns the dialog's `onOpenAutoFocus`: it notes the
 * field focused as the dialog opens (before focus moves to the dialog), and
 * the keystrokes of the burst still going on are typed into that field.
 */
export function useKeepTyping(
  enabled: boolean,
  now: () => number = Date.now,
): () => void {
  const burst = useRef<{ field: TextField; last: number } | null>(null);
  // oxlint-disable-next-line ban-use-effect/ban-use-effect -- document listeners for the dialog's lifetime
  useEffect(() => {
    if (!enabled) return;
    const doc = globalThis.document;
    const onKeyDown = (event: KeyboardEvent) => {
      const typing = burst.current;
      if (!typing) return;
      if (event.key === "Shift" || event.key === "CapsLock") return;
      const at = now();
      const text =
        (event.key.length === 1 || event.key === "Backspace") &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !event.isComposing;
      if (
        !text ||
        at - typing.last > KEEP_TYPING_GAP_MS ||
        !typing.field.isConnected ||
        // Typed into the field itself (focus never left it): as usual.
        event.target === typing.field
      ) {
        burst.current = null;
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      typing.last = at;
      typeIntoField(typing.field, event.key);
    };
    const end = () => {
      burst.current = null;
    };
    doc.addEventListener("keydown", onKeyDown, true);
    doc.addEventListener("pointerdown", end, true);
    return () => {
      doc.removeEventListener("keydown", onKeyDown, true);
      doc.removeEventListener("pointerdown", end, true);
      burst.current = null;
    };
  }, [enabled, now]);
  return () => {
    const active = globalThis.document?.activeElement ?? null;
    burst.current =
      enabled && isTextField(active) ? { field: active, last: now() } : null;
  };
}
