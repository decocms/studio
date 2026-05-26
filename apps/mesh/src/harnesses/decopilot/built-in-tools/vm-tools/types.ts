import type { SandboxProvider } from "@decocms/sandbox/provider";
import type { MeshContext } from "@/core/mesh-context";
import type { PendingImage } from "../take-screenshot";
import type { HtmlPageBuffer } from "./html-page-buffer";

export interface VmToolsParams {
  readonly runner: SandboxProvider;
  /**
   * Lazy handle resolver. Invoked on every tool call; caller is expected
   * to memoise so the first invocation provisions and later calls reuse.
   */
  readonly ensureHandle: () => Promise<string>;
  /**
   * Invalidate the memoised handle and (for ephemeral branches) reap the
   * underlying `vmMap` entry, so the next `ensureHandle` call provisions
   * a fresh sandbox. Used by the call-level retry layer when the daemon
   * proxy reports the sandbox is unreachable.
   */
  readonly invalidateHandle: () => Promise<void>;
  /**
   * When true, the call wrapper will retry once on
   * `DaemonUnreachableError` (after invalidating the handle). Should be
   * enabled for ephemeral agents (no server-button UI to restart from)
   * and disabled for GitHub-linked agents where the user may have
   * paused the sandbox intentionally.
   */
  readonly canAutoRestart: boolean;
  /**
   * Buffer for coalescing `pages/<slug>.html` mirrors. `write`/`edit` calls
   * enqueue the new content and return the preview shape synchronously; the
   * actual S3 PUT runs from `flush()`, which the dispatch layer wires into
   * `onStepFinish` so the iframe never races the write.
   */
  readonly htmlPageBuffer: HtmlPageBuffer;
  readonly toolOutputMap: Map<string, string>;
  readonly needsApproval: boolean;
  /**
   * Shared queue for vision inputs that should be injected into the next
   * model turn. The `read` tool pushes here when it loads an image; the
   * queue is flushed by `prepareStep` in dispatch-run.ts.
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
