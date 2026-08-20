import {
  defaultThreadRuntime,
  type ThreadRuntime,
} from "@decocms/shared/thread/session-runtime";
import { useVirtualMCPs } from "./hooks/use-virtual-mcp";

/**
 * The runtime a NEW chat on a project would be stamped with.
 *
 * This is a PROJECT question, deliberately distinct from "what runtime is the
 * session I am in?" — that one is answered by the thread's own stamp and never
 * by this. The only callers are the ones deciding what a not-yet-existing
 * thread will be: the reuse predicate and the create paths.
 *
 * Returns `undefined` when the project isn't in the loaded list, so a caller
 * degrades to the server's own default instead of guessing.
 */
export function useProjectDefaultRuntime(): (
  virtualMcpId: string | undefined,
) => ThreadRuntime | undefined {
  const projects = useVirtualMCPs() ?? [];
  return (virtualMcpId) => {
    if (!virtualMcpId) return undefined;
    const project = projects.find((p) => p.id === virtualMcpId);
    return project ? defaultThreadRuntime(project.metadata) : undefined;
  };
}
