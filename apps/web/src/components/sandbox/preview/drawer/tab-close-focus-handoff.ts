const DEFAULT_HANDOFF_TIMEOUT_MS = 10_000;

export interface TabCloseFocusHandoff {
  /**
   * Restore focus only after React has committed the source button's removal.
   * Calling this after the handoff was cancelled is a safe no-op.
   */
  focusAfterSourceRemoval: (focusTarget: () => boolean) => void;
  cancel: () => void;
}

interface TabCloseFocusHandoffOptions {
  onFinish?: () => void;
  timeoutMs?: number;
}

function isRepeatedCloseActivation(
  event: KeyboardEvent,
  source: HTMLElement,
): boolean {
  return (
    source.ownerDocument.activeElement === source &&
    (event.key === "Enter" || event.key === " " || event.key === "Spacebar")
  );
}

/**
 * Owns the short focus gap between a confirmed asynchronous close and React's
 * removal commit. A MutationObserver makes the handoff commit-aware; document
 * intent listeners keep a later pointer or keyboard action authoritative.
 */
export function createTabCloseFocusHandoff(
  source: HTMLElement,
  options: TabCloseFocusHandoffOptions = {},
): TabCloseFocusHandoff {
  const document = source.ownerDocument;
  const view = document.defaultView;
  const observationRoot =
    source.closest<HTMLElement>('[role="tablist"]') ??
    source.parentElement ??
    document.body;
  let active = true;
  let performingHandoffFocus = false;
  let observer: MutationObserver | null = null;
  let timeout: number | null = null;

  const finish = () => {
    if (!active) return;
    active = false;
    observer?.disconnect();
    observer = null;
    if (timeout !== null && view) view.clearTimeout(timeout);
    timeout = null;
    document.removeEventListener("pointerdown", cancelForPointerIntent, true);
    document.removeEventListener("keydown", cancelForKeyboardIntent, true);
    document.removeEventListener("focusin", cancelForFocusMove, true);
    options.onFinish?.();
  };

  const cancelForPointerIntent = (event: PointerEvent) => {
    // A repeated activation of the pending close is rejected by the caller's
    // synchronous guard and does not express a different focus destination.
    const target = event.target;
    if (!(target instanceof Node) || !source.contains(target)) finish();
  };
  const cancelForKeyboardIntent = (event: KeyboardEvent) => {
    if (!isRepeatedCloseActivation(event, source)) finish();
  };
  const cancelForFocusMove = (event: FocusEvent) => {
    if (performingHandoffFocus) return;
    const target = event.target;
    if (!(target instanceof Node) || !source.contains(target)) finish();
  };

  document.addEventListener("pointerdown", cancelForPointerIntent, true);
  document.addEventListener("keydown", cancelForKeyboardIntent, true);
  document.addEventListener("focusin", cancelForFocusMove, true);

  timeout =
    view?.setTimeout(finish, options.timeoutMs ?? DEFAULT_HANDOFF_TIMEOUT_MS) ??
    null;

  return {
    focusAfterSourceRemoval(focusTarget) {
      if (!active) return;

      const focusIfCommitted = () => {
        if (source.isConnected) return;
        performingHandoffFocus = true;
        try {
          if (focusTarget()) finish();
        } finally {
          performingHandoffFocus = false;
        }
      };

      observer = new MutationObserver(focusIfCommitted);
      observer.observe(observationRoot, { childList: true, subtree: true });
      // Covers an unusually eager commit between the async response and this
      // arm call without relying on frame timing.
      focusIfCommitted();
    },
    cancel: finish,
  };
}
