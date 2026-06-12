import type { UIMessageChunk } from "@decocms/harness/types";
import type { HarnessStreamInput } from "@decocms/harness/types";

/**
 * SandboxClient — owns "merge the HarnessDeps bag + run the harness" (spec
 * §5.2/§5.3). Impls: InProcessSandboxClient (mesh, direct call) and
 * RemoteSandboxClient (@decocms/sandbox, step 4). Lives in-place for now (step
 * 1a); the interface moves to @decocms/sandbox in step 4.
 */
export interface SandboxClient {
  /** Yields raw UIMessageChunk — byte-identical to today's localDispatch
   *  return, consumed by mesh's consumeHarnessStream with NO adapter/framing. */
  dispatch(input: HarnessStreamInput): AsyncIterable<UIMessageChunk>;
  /** Sandbox-related info, as the daemon already exposes. */
  getPreviewUrl?(): Promise<string | null>;
}
