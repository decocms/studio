const MAX_CONCURRENT_PREVIEW_IFRAMES = 12;

const active = new Set<string>();

export function tryAcquirePreviewIframeSlot(id: string): boolean {
  if (active.has(id)) return true;
  if (active.size >= MAX_CONCURRENT_PREVIEW_IFRAMES) return false;
  active.add(id);
  return true;
}

export function releasePreviewIframeSlot(id: string): void {
  active.delete(id);
}
