import type { UIMessageChunk } from "@decocms/shared/harness/types";
import type { HarnessStreamInput } from "@decocms/shared/harness/types";

/**
 * SandboxClient — owns "merge the HarnessDeps bag + run the harness" (spec
 * §5.2/§5.3). Impl: InProcessSandboxClient (studio, direct call).
 */
export interface SandboxClient {
  /** Yields raw UIMessageChunk — byte-identical to today's localDispatch
   *  return, consumed by studio's consumeHarnessStream with NO adapter/framing. */
  dispatch(input: HarnessStreamInput): AsyncIterable<UIMessageChunk>;
  /** Sandbox-related info, as the daemon already exposes. */
  getPreviewUrl?(): Promise<string | null>;
}
