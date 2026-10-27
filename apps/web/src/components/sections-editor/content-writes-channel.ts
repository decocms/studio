/**
 * Tells the editor's other views in this browser (another tab or window on
 * the same draft) that this one just wrote, so they read the content again
 * at once instead of at their next poll (up to 30 s later, never while in
 * the background). A view that kept its older copy would build its next
 * change on it, and that change would then be refused as "changed while you
 * were editing" for the person's own save in the other view.
 */

const CHANNEL = "decocms:content-writes";

interface ContentWriteMessage {
  /** The editor's decofile cache key (org/project/branch) that was written. */
  cacheKey: string;
}

type Listener = (cacheKey: string) => void;

const listeners = new Set<Listener>();
/** One channel per page: a message never comes back to the view that sent it. */
let channel: BroadcastChannel | null | undefined;

function openChannel(): BroadcastChannel | null {
  if (channel !== undefined) return channel;
  channel = null;
  try {
    if (typeof BroadcastChannel === "function") {
      channel = new BroadcastChannel(CHANNEL);
      channel.addEventListener("message", (event: MessageEvent) => {
        const cacheKey = (event.data as Partial<ContentWriteMessage> | null)
          ?.cacheKey;
        if (typeof cacheKey !== "string") return;
        for (const listener of [...listeners]) listener(cacheKey);
      });
    }
  } catch {
    channel = null;
  }
  return channel;
}

/** This view's write of `cacheKey` landed: the other views re-read it. */
export function announceContentWrite(cacheKey: string) {
  try {
    openChannel()?.postMessage({ cacheKey } satisfies ContentWriteMessage);
  } catch {
    // No other view hears it; their poll catches up.
  }
}

/** Calls `listener` with the cache key each write in another view wrote. */
export function onContentWrittenElsewhere(listener: Listener): () => void {
  openChannel();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
