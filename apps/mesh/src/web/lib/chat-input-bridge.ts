/**
 * Chat input bridge — lets non-input components (today: the Page Editor
 * preview iframe handler) compose text into the active chat input
 * without coupling them to ChatInput's local state.
 *
 * ChatInput hands us the *ref object* it uses to talk to its tiptap
 * editor — not the value of `ref.current`. We dereference at call time
 * (when someone clicks a prompt card), which happens long after the
 * editor's `useImperativeHandle` has populated the ref. Registering
 * `ref.current` from a `useEffect([])` race-loses because the parent
 * effect can fire before the child's `useImperativeHandle`.
 *
 * Module-level singleton: only one chat input is mounted at a time in
 * the agent shell, so this is safe.
 */

import type { RefObject } from "react";
import type { TiptapInputHandle } from "@/web/components/chat/tiptap/input";

let activeHandleRef: RefObject<TiptapInputHandle | null> | null = null;
let activeSubmitter: (() => void) | null = null;

export function setActiveChatInputHandleRef(
  ref: RefObject<TiptapInputHandle | null> | null,
) {
  activeHandleRef = ref;
}

/**
 * Register the chat input's submit function so non-input components can
 * trigger a send programmatically. Mirrors `setActiveChatInputHandleRef`
 * — single mounted chat input at a time, module-level singleton is safe.
 *
 * The chat input registers a stable wrapper that dereferences the latest
 * handleSubmit via a ref, so the bridge always invokes the most recent
 * closure (which has the current tiptapDoc / streaming state).
 */
export function setActiveChatInputSubmitter(submit: (() => void) | null) {
  activeSubmitter = submit;
}

/**
 * Replace the current chat input text with `text` and focus it.
 * Returns true when the bridge had a registered handle, false otherwise
 * (caller can fall back to a notification or no-op).
 */
export function composeChatInput(text: string): boolean {
  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- non-React utility; only called from event handlers (e.g. window message listeners), never during a component render
  const handle = activeHandleRef?.current;
  if (!handle) return false;
  handle.clear();
  handle.appendText(text);
  handle.focus();
  return true;
}

/**
 * Compose `text` into the chat input AND trigger submission. Used by the
 * Page Editor review-tip Accept flow: the user clicks Accept on a
 * tooltip → Studio fills the input with the suggestion's prompt and
 * fires the agent immediately, no extra click required.
 *
 * Submission happens on the next microtask so tiptap's onUpdate has a
 * chance to commit the appended text into `tiptapDoc` state — without
 * the delay, the submit closure reads a stale empty document and fires
 * a no-op.
 */
export function composeAndSubmitChatInput(text: string): boolean {
  if (!composeChatInput(text)) return false;
  if (!activeSubmitter) return false;
  // Defer to allow tiptap's onUpdate (called via TipTap's transaction
  // dispatch) to flush state before the submit reads it.
  queueMicrotask(() => {
    const submit = activeSubmitter;
    if (submit) submit();
  });
  return true;
}
