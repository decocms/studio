import {
  defaultThreadRuntime,
  parseThreadRuntime,
  readThreadRuntime,
  type ThreadRuntime,
} from "@decocms/shared/thread/session-runtime";
import { resolvePreviewServerUrl } from "@decocms/shared/deco-site-production-url";
import { useOptionalChatTask } from "@/components/chat/chat-context";
import {
  type PrDraftPreview,
  usePrDraftPreview,
} from "@/hooks/use-pr-draft-preview";
import { useVirtualMCP } from "@/sdk";

export interface SessionRuntime {
  /** THIS session's runtime, read from the active thread's own stamp. */
  runtime: ThreadRuntime;
  /**
   * The project row this answer was derived from has loaded. While it hasn't,
   * `runtime` is the SHAPE of an answer, not one — an unstamped thread on an
   * unloaded project reads as `sandbox` purely because that is the default of
   * a project we cannot see yet. Anything that ACTS on the runtime (booting a
   * pod) must require this; anything that merely renders may use the default.
   */
  resolved: boolean;
  /** What a NEW chat on this project would be stamped with. A different
   *  question — never use it to decide what the current session is. */
  projectDefault: ThreadRuntime;
  /** The URL a CMS session renders against (a pull request draft's deploy
   *  preview once known), or `null`. Ungated by the Fast Preview switch. */
  previewServerUrl: string | null;
  /** Where a publish lands: the project's preview server, whatever the draft
   *  renders on. */
  productionUrl: string | null;
  /** Set on a pull request draft (`Release.preview`). Until its preview is
   *  `ready` it renders on `productionUrl`. */
  pullRequestDraft: PrDraftPreview | null;
}

/**
 * The one hook every surface asks "what runtime am I in?".
 *
 * One call, so a surface cannot read the project's answer when
 * it meant the session's. Outside a thread (`useOptionalChatTask` returns
 * null) `runtime` degrades to the project default, which is the only honest
 * answer when there is no session.
 */
export function useSessionRuntime(
  virtualMcpId: string | null | undefined,
): SessionRuntime {
  const project = useVirtualMCP(virtualMcpId);
  const task = useOptionalChatTask();
  const metadata = project?.metadata;
  const thread = task?.activeTask;
  const stamp = parseThreadRuntime(thread?.metadata?.runtime);
  // A `/watch` synthetic carries no metadata, so its missing stamp is "not
  // loaded", not "unstamped" — the same distinction `Task.partial` exists for.
  const threadLoaded = !!thread && !thread.partial;
  const runtime = readThreadRuntime(thread?.metadata, metadata);
  const productionUrl = resolvePreviewServerUrl(metadata);
  const prDraft = usePrDraftPreview({
    project,
    branch: task?.currentBranch ?? null,
    runtime,
  });
  return {
    runtime,
    // A stamp is self-sufficient. Without one, the answer is the project
    // default — which is only authoritative once BOTH rows have landed.
    resolved: !!stamp || (threadLoaded && !!project),
    projectDefault: defaultThreadRuntime(metadata),
    previewServerUrl: prDraft?.url ?? productionUrl,
    productionUrl,
    pullRequestDraft: prDraft,
  };
}
