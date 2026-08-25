/**
 * Lock-aware submit-settings resolver.
 *
 * Once a thread row carries a non-null `harness_id`, the thread is "locked":
 * its harness and branch are immutable for the life of the thread. The UI may
 * still display the current global picker selection, but
 * the submit payload must NOT override the branch — the server reads it from
 * the thread row. Harness selection belongs to the receiving app surface and
 * is never a chat-submit option.
 *
 * For unlocked threads (no row yet, or `harness_id IS NULL`), hosted web sends
 * the selected branch and the server pins Decopilot.
 *
 * Pure function, no I/O. See spec:
 * docs/superpowers/specs/2026-06-03-lock-thread-harness-and-branch-design.md
 */

export interface ResolveSubmitSettingsThread {
  harness_id?: string | null;
  branch?: string | null;
}

export interface ResolveSubmitSettingsGlobals {
  branch?: string | null;
}

export interface ResolveSubmitSettingsResult {
  branch?: string | null;
}

export function resolveSubmitSettings(args: {
  thread: ResolveSubmitSettingsThread | null;
  globals: ResolveSubmitSettingsGlobals;
}): ResolveSubmitSettingsResult {
  if (args.thread?.harness_id != null) {
    return {};
  }
  return {
    branch: args.globals.branch ?? null,
  };
}
