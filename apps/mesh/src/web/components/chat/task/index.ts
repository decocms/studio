/**
 * Thread filter helpers and types. The data layer lives in
 * `../store/` — see `ThreadManagerStore` and the hooks in `store/hooks.tsx`.
 *
 * Spec: docs/superpowers/specs/2026-05-19-thread-manager-store-design.md
 */
export type { Task, ChatMessage } from "./types.ts";
export { filterThreads } from "./thread-filter";
export type { ThreadFilter } from "./thread-filter";
