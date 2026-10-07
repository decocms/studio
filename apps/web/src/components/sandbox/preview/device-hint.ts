export type PreviewDeviceSize = "mobile" | "tablet" | "desktop";

/**
 * Deco reads `deviceHint` to force SSR device matchers (see deco `deviceOf`).
 * Falls back to the unmodified `url` on a malformed input instead of throwing
 * mid-render and taking down the whole preview panel.
 */
export function withDeviceHint(url: string, device: PreviewDeviceSize): string {
  try {
    const parsed = new URL(url, window.location.href);
    parsed.searchParams.set("deviceHint", device);
    return parsed.href;
  } catch {
    return url;
  }
}
