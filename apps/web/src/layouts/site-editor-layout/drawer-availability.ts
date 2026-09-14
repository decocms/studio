import type { ThreadRuntime } from "@decocms/shared/thread/session-runtime";

export interface SiteEditorDrawerAvailability {
  /** The agent or active thread has a repository the sandbox can clone. */
  hasClonableSource: boolean;
  /** The active thread's immutable runtime, not the agent's default runtime. */
  runtime: ThreadRuntime;
}

/**
 * The Site Editor owns the console drawer, so availability depends only on
 * whether this session can run one. Preview, Content, and Code inherit the
 * result by rendering below the same route layout.
 */
export function shouldShowSiteEditorDrawer(
  input: SiteEditorDrawerAvailability,
): boolean {
  return input.hasClonableSource && input.runtime === "sandbox";
}
