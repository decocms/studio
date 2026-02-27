/**
 * Decopilot Route
 *
 * Re-exports from the decopilot module for backwards compatibility.
 * The actual implementation lives in ./decopilot/routes.ts
 */

export { createDecopilotRoutes } from "./decopilot/routes";
export type { DecopilotDeps } from "./decopilot/routes";
export type { StreamRequest } from "./decopilot/schemas";
