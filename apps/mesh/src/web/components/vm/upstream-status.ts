/**
 * Upstream HTTP probe status emitted by the daemon over SSE.
 * Mirrors the daemon's `UpstreamStatus` (packages/sandbox/daemon/probe.ts).
 */
export type UpstreamStatus = "booting" | "online" | "offline";
