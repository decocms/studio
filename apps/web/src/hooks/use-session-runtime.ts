import {
  defaultThreadRuntime,
  readThreadRuntime,
  type ThreadRuntime,
} from "@decocms/shared/thread/session-runtime";
import { resolvePreviewServerUrl } from "@decocms/shared/deco-site-production-url";
import { useOptionalChatTask } from "@/components/chat/chat-context";
import { useVirtualMCP } from "@/sdk";

export interface SessionRuntime {
  /** THIS session's runtime, read from the active thread's own stamp. */
  runtime: ThreadRuntime;
  /** What a NEW chat on this project would be stamped with. A different
   *  question — never use it to decide what the current session is. */
  projectDefault: ThreadRuntime;
  /** The URL a CMS session renders against, or `null`. Ungated: a project can
   *  have one without the Fast Preview switch being on. */
  previewServerUrl: string | null;
}

/**
 * The one hook every surface asks "what runtime am I in?".
 *
 * Three fields, one call, so a surface cannot read the project's answer when
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
  return {
    runtime: readThreadRuntime(task?.activeTask?.metadata, metadata),
    projectDefault: defaultThreadRuntime(metadata),
    previewServerUrl: resolvePreviewServerUrl(metadata),
  };
}
