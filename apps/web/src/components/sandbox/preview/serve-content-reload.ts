/**
 * After a `deco serve` save, the preview must end up on the saved content.
 *
 * A dev server that reloads its pages on content changes usually does it
 * within a few hundred ms of the save, so the editor first gives the frame
 * `waitMs` to reload itself, and reloads it otherwise. A reload by the site is
 * not proof, though: a site that reloads on the file change itself (rather
 * than once its server has re-read the content) renders the previous save,
 * and the preview stays one edit behind. The editor can't read a cross-origin
 * frame to check, so after the site's own reload it reloads once more,
 * `confirmMs` later, when the server has the content. At most one extra reload
 * per save, never a loop: the editor's own reloads aren't watched.
 */

/** How long after a save the frame may take to reload itself. */
const SERVE_SELF_RELOAD_WAIT_MS = 1500;
/** How long after the site's own reload the editor confirms it with one more. */
const SERVE_CONFIRM_RELOAD_DELAY_MS = 500;

export function watchServeContentReload({
  iframe,
  reload,
  waitMs = SERVE_SELF_RELOAD_WAIT_MS,
  confirmMs = SERVE_CONFIRM_RELOAD_DELAY_MS,
}: {
  iframe: Pick<HTMLIFrameElement, "addEventListener" | "removeEventListener">;
  reload: () => void;
  waitMs?: number;
  confirmMs?: number;
}): () => void {
  let confirmTimer: ReturnType<typeof setTimeout> | undefined;
  const reloadedItself = () => {
    clearTimeout(waitTimer);
    confirmTimer = setTimeout(reload, confirmMs);
  };
  iframe.addEventListener("load", reloadedItself, { once: true });
  const waitTimer = setTimeout(() => {
    iframe.removeEventListener("load", reloadedItself);
    reload();
  }, waitMs);
  return () => {
    clearTimeout(waitTimer);
    clearTimeout(confirmTimer);
    iframe.removeEventListener("load", reloadedItself);
  };
}
