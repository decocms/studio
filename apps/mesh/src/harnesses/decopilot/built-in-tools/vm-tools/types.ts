import type { SandboxFsHooks } from "@decocms/sandbox/provider";

export interface VmToolObjectStorage {
  presignedGetUrl(key: string): Promise<string>;
  presignedPutUrl(key: string): Promise<string>;
}

export interface VmToolContext {
  objectStorage?: VmToolObjectStorage | null;
  organization?: { slug?: string | null } | null;
  baseUrl: string;
}

export interface PendingImage {
  url: string;
  mediaType: string;
  pageUrl?: string;
  label?: string;
}

export interface HtmlPageBuffer {
  enqueue(
    rawPath: string,
    content: string,
  ): { slug: string; key: string; url: string; bytes: number } | null;
  flush(): Promise<void>;
}

export interface VmToolsParams {
  /**
   * Flat sandbox filesystem hooks (read/write/edit/bash/glob/grep + the
   * `onProxy` escape hatch) over `SandboxProvider.proxyDaemonRequest`. The
   * handle resolution, daemon-reachability detection, and auto-restart retry
   * layer all live inside these closures (built by `createSandboxFsHooks`),
   * so the tools here never touch `SandboxProvider` — that import would
   * re-introduce the harness→sandbox cycle (spec §4.3).
   */
  readonly fs: SandboxFsHooks;
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
  readonly ctx: VmToolContext;
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
