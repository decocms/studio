/**
 * Lock-aware submit-settings resolver.
 *
 * Once a thread row carries a non-null `harness_id`, the thread is "locked":
 * its harness, sandbox provider, and branch are immutable for the life of the
 * thread. The UI may still display the current global picker selection, but
 * the submit payload must NOT include those three fields — the server reads
 * them from the thread row.
 *
 * For unlocked threads (no row yet, or a legacy row with `harness_id IS
 * NULL`), hosted web explicitly pins Decopilot on the managed agent sandbox.
 *
 * Pure function, no I/O. See spec:
 * docs/superpowers/specs/2026-06-03-lock-thread-harness-and-branch-design.md
 */

export interface ResolveSubmitSettingsThread {
  harness_id?: string | null;
  sandbox_provider_kind?: string | null;
  branch?: string | null;
}

export interface ResolveSubmitSettingsGlobals {
  branch?: string | null;
}

export interface ResolveSubmitSettingsResult {
  harnessId?: "decopilot";
  sandboxProviderKind?: "agent-sandbox";
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
    harnessId: "decopilot",
    sandboxProviderKind: "agent-sandbox",
    branch: args.globals.branch ?? null,
  };
}
