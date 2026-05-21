/**
 * `HarnessContext` is defined in `apps/mesh/src/harnesses` so the laptop
 * link daemon can construct one without depending on cluster modules.
 * This file re-exports it for cluster-side consumers that still import
 * via the historical `@/core/harness-context` path.
 */
export type { HarnessContext } from "../harnesses";
