/**
 * `HarnessContext` is defined in `apps/api/src/harnesses` beside the hosted
 * harness contract. This file re-exports it for cluster-side consumers that
 * still import via the historical `@/core/harness-context` path.
 */
export type { HarnessContext } from "../harnesses";
