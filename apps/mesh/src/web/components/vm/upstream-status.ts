/**
 * Internal preview-state triplet. Originally mirrored the daemon's
 * `UpstreamStatus`; the daemon now emits richer `LifecycleState` events
 * instead, and `preview.tsx` projects `lifecycle.phase` into this shape
 * for `computePreviewState`.
 */
export type UpstreamStatus = "booting" | "online" | "offline";
