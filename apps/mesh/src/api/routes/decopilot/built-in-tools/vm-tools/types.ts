import type { SandboxRunner } from "@decocms/sandbox/runner";
import type { MeshContext } from "@/core/mesh-context";
import type { PendingImage } from "../take-screenshot";

export interface VmToolsParams {
  readonly runner: SandboxRunner;
  /**
   * Lazy handle resolver. Invoked on every tool call; caller is expected
   * to memoise so the first invocation provisions and later calls reuse.
   */
  readonly ensureHandle: () => Promise<string>;
  readonly toolOutputMap: Map<string, string>;
  readonly needsApproval: boolean;
  /**
   * Shared queue for vision inputs that should be injected into the next
   * model turn. The `read` tool pushes here when it loads an image; the
   * queue is flushed by `prepareStep` in stream-core.ts.
   */
  readonly pendingImages: PendingImage[];
  /**
   * Mesh context for tools that need to mint presigned URLs against the
   * org's object storage (`copy_to_sandbox`, `share_with_user`) or
   * resolve the org id for stable file URLs.
   */
  readonly ctx: MeshContext;
  /**
   * Current chat thread id. `share_with_user` writes artifacts under
   * `model-outputs/<threadId>/<filename>` so the chat UI can list them.
   */
  readonly threadId: string;
  /**
   * Virtual MCP ID. `set_vm_config` mirrors packageManager / previewPort
   * back to the Virtual MCP metadata so new branch sandboxes are
   * provisioned with the updated workload rather than stale defaults.
   */
  readonly virtualMcpId: string;
}
