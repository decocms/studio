const MAX_CONCURRENT_PREVIEW_IFRAMES = 12;

const active = new Set<string>();
const waiters = new Set<() => void>();

function notifyWaiters(): void {
  for (const waiter of waiters) {
    waiter();
  }
}

export function tryAcquirePreviewIframeSlot(id: string): boolean {
  if (active.has(id)) return true;
  if (active.size >= MAX_CONCURRENT_PREVIEW_IFRAMES) return false;
  active.add(id);
  return true;
}

export function releasePreviewIframeSlot(id: string): void {
  if (!active.delete(id)) return;
  notifyWaiters();
}

export function onPreviewIframeSlotAvailable(callback: () => void): () => void {
  waiters.add(callback);
  return () => {
    waiters.delete(callback);
  };
}
