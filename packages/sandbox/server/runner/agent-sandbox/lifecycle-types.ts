/**
 * Re-export from the runner-root lifecycle types module. Kept for back-compat
 * with consumers that import via `@decocms/sandbox/runner/agent-sandbox`
 * (notably the studio web bundle's vm-events context). New code should import
 * from `@decocms/sandbox/runner`.
 */

export type { ClaimFailureReason, ClaimPhase } from "../lifecycle-types";
