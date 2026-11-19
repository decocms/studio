/**
 * How long after a frame load (or HTML swap) a focus move into the frame is
 * taken as the page's own script, not the user. A site's cookie banner took
 * focus about 60 ms after load; slow pages run their scripts later.
 */
const FRAME_FOCUS_GUARD_MS = 3000;

interface FrameFocusGuard {
  extend: (ms: number) => void;
}

const guards = new WeakMap<HTMLIFrameElement, FrameFocusGuard>();

/**
 * How long a click or key press keeps a page user-activated (Chrome's
 * transient activation).
 */
const ACTIVATION_MS = 5000;

/** When Studio's own document last had a key press or pointer press. */
const lastInputs = new WeakMap<Document, { at: number }>();

function lastInput(doc: Document): { at: number } {
  const known = lastInputs.get(doc);
  if (known) return known;
  const tracked = { at: Number.NEGATIVE_INFINITY };
  const note = () => {
    tracked.at = performance.now();
  };
  doc.addEventListener("keydown", note, true);
  doc.addEventListener("pointerdown", note, true);
  lastInputs.set(doc, tracked);
  return tracked;
}
// Typing before the first frame load counts too.
if (typeof document !== "undefined") lastInput(document);

/**
 * A click or key press in the frame activates Studio's page too; a script's
 * `focus()` doesn't. Studio can't see the pointer over a cross-origin frame,
 * so an activation without Studio input of its own is a click on the page.
 * After recent Studio input it can't tell, and keeps the field's focus.
 */
function userEnteredFrame(doc: Document, input: { at: number }): boolean {
  const activation = doc.defaultView?.navigator.userActivation;
  if (!activation?.isActive) return false;
  return performance.now() - input.at > ACTIVATION_MS;
}

/** The Studio element that has focus, if any (not the frame, not the body). */
function focusedInStudio(
  doc: Document,
  iframe: HTMLIFrameElement,
): HTMLElement | null {
  const active = doc.activeElement;
  if (!(active instanceof HTMLElement)) return null;
  if (active === iframe || active === doc.body) return null;
  return active;
}

/**
 * The previewed page is the user's site: its scripts (a cookie banner, a
 * newsletter popup) may call `focus()` when it loads, and a cross-origin frame
 * may take focus from Studio. Each save reloads or swaps the page, so a field
 * being typed in would lose its keystrokes to the site.
 *
 * For `ms` after this call, focus moving from a Studio element into the frame
 * goes back to that element, unless the user moved it: a click on the page
 * ({@link userEnteredFrame}) or Tab.
 */
export function guardFrameFocus(
  iframe: HTMLIFrameElement,
  ms: number = FRAME_FOCUS_GUARD_MS,
): void {
  const existing = guards.get(iframe);
  if (existing) {
    existing.extend(ms);
    return;
  }
  const doc = iframe.ownerDocument;
  const win = doc.defaultView;
  if (!win) return;
  const input = lastInput(doc);

  let previous = focusedInStudio(doc, iframe);
  let tabbed = false;

  const onFocusIn = () => {
    const next = focusedInStudio(doc, iframe);
    if (!next) return;
    previous = next;
    tabbed = false;
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Tab") tabbed = true;
  };
  // Focus entering a frame blurs Studio's window; leaving the browser does too.
  const onBlur = () => {
    if (doc.activeElement !== iframe) return;
    if (tabbed || userEnteredFrame(doc, input)) return;
    const target = previous;
    if (!target?.isConnected) return;
    // Focused during the blur, the element is active but keys still reach the frame.
    setTimeout(() => {
      if (doc.activeElement === iframe) target.focus({ preventScroll: true });
    }, 0);
  };

  let timer = setTimeout(dispose, ms);
  function dispose() {
    clearTimeout(timer);
    doc.removeEventListener("focusin", onFocusIn, true);
    doc.removeEventListener("keydown", onKeyDown, true);
    win?.removeEventListener("blur", onBlur);
    guards.delete(iframe);
  }

  doc.addEventListener("focusin", onFocusIn, true);
  doc.addEventListener("keydown", onKeyDown, true);
  win.addEventListener("blur", onBlur);
  guards.set(iframe, {
    extend: (next) => {
      clearTimeout(timer);
      timer = setTimeout(dispose, next);
    },
  });
}
