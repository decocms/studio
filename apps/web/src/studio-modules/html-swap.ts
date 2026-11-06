/**
 * HTML swap: shows a save in a Blocks v8 site's page without reloading it.
 * On `html-swap:refresh` it fetches the page's URL again (the frame's draft
 * pointer and options are in it), or the new URL Studio names (a save moved
 * the draft pointer; later refreshes read it), waits for the new stylesheets, and swaps the
 * document's content inside a View Transition, or at once where the browser
 * has none. It reports `html-swap:start` and `html-swap:end` (or
 * `html-swap:error`, where Studio reloads the frame instead), so the preview's
 * progress bar runs exactly as long as the swap.
 *
 * A refresh asked while one runs supersedes it: the older one stops and
 * reports nothing. The other modules in the page hear the swap through
 * {@link HTML_SWAP_EVENT} on `window` (the wireframe re-attaches its outline).
 *
 * The window, its listeners and the modules survive the swap; the new HTML's
 * scripts don't run (as with the in-place render v7 sites get), so what the
 * page's scripts made interactive stays as it was until the next load.
 */
import { defineStudioModule } from "./channel";
import {
  HTML_SWAP_EVENT,
  type HtmlSwapEventDetail,
  type HtmlSwapIn,
  type HtmlSwapOut,
} from "./messages";

/** Keeps the page's own CSS transitions from animating the swap. */
const NO_TRANSITIONS_ID = "deco-studio-no-transitions";

interface ViewTransitionLike {
  finished: Promise<void>;
  ready?: Promise<void>;
  updateCallbackDone?: Promise<void>;
}

/** A skipped transition rejects promises nobody else waits on: settle them. */
function settle(transition: ViewTransitionLike) {
  const ignore = () => {};
  transition.ready?.catch(ignore);
  transition.updateCallbackDone?.catch(ignore);
  transition.finished.catch(ignore);
}

/** Runs `swap` inside a View Transition when the browser has them; resolves once it's over. */
function withViewTransition(doc: Document, swap: () => void): Promise<void> {
  const start = (
    doc as Document & {
      startViewTransition?: (update: () => void) => ViewTransitionLike;
    }
  ).startViewTransition;
  if (typeof start !== "function") {
    swap();
    return Promise.resolve();
  }
  const transition = start.call(doc, swap);
  settle(transition);
  // A skipped transition (a quicker refresh) still ran or drops the update.
  return transition.finished.catch(() => {});
}

function announce(phase: HtmlSwapEventDetail["phase"]) {
  dispatchEvent(
    new CustomEvent<HtmlSwapEventDetail>(HTML_SWAP_EVENT, {
      detail: { phase },
    }),
  );
}

/** Replaces the document with `html`'s: the root's attributes and its content. */
function replaceDocument(doc: Document, html: string) {
  const next = new DOMParser().parseFromString(html, "text/html");
  const root = doc.documentElement;
  for (const { name } of Array.from(root.attributes)) {
    if (!next.documentElement.hasAttribute(name)) root.removeAttribute(name);
  }
  for (const { name, value } of Array.from(next.documentElement.attributes)) {
    root.setAttribute(name, value);
  }
  const style = next.createElement("style");
  style.id = NO_TRANSITIONS_ID;
  style.textContent = "* { transition: none !important; }";
  next.head.append(style);
  root.innerHTML = next.documentElement.innerHTML;
}

export default defineStudioModule<HtmlSwapIn, HtmlSwapOut>((channel) => {
  let current: AbortController | null = null;
  /**
   * The URL whose HTML the page shows. A swapped URL stays out of the address
   * bar: `history.replaceState` would wake the page's router, which then
   * renders into the elements the swap replaced (React's "removeChild"
   * errors).
   */
  let shown = location.href;

  const refresh = async (id: number, url: string | undefined) => {
    current?.abort();
    const ctrl = new AbortController();
    current = ctrl;
    const live = () => current === ctrl;
    channel.send({ type: "html-swap:start", id });
    announce("start");
    try {
      // A new URL of the page (a moved draft pointer), never another origin's.
      const target = new URL(url ?? shown, location.href);
      if (target.origin !== location.origin) {
        throw new Error(`Not this page's origin: ${target.origin}`);
      }
      const res = await fetch(target.href, {
        headers: { accept: "text/html" },
        credentials: "same-origin",
        cache: "no-store",
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`The page answered ${res.status}`);
      const html = await res.text();
      // The new stylesheets in the cache first, or the swap shows the page unstyled.
      const head = new DOMParser().parseFromString(html, "text/html").head;
      await Promise.all(
        Array.from(
          head.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'),
          (link) =>
            link.href
              ? fetch(link.href, { signal: ctrl.signal }).catch(() => {})
              : null,
        ),
      );
      if (!live()) return;
      await withViewTransition(document, () => replaceDocument(document, html));
      shown = target.href;
      document.getElementById(NO_TRANSITIONS_ID)?.remove();
      if (!live()) return;
      current = null;
      announce("end");
      channel.send({ type: "html-swap:end", id });
    } catch (error) {
      if (!live()) return;
      current = null;
      announce("end");
      channel.send({
        type: "html-swap:error",
        id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  channel.on((message) => {
    if (
      message.type === "html-swap:refresh" &&
      typeof message.id === "number"
    ) {
      void refresh(
        message.id,
        typeof message.url === "string" ? message.url : undefined,
      );
    }
  });
});
