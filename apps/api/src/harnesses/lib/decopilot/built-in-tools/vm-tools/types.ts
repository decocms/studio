import type { SandboxFsHooks } from "./sandbox-fs-hooks-types";

export interface PendingImage {
  url: string;
  mediaType: string;
  pageUrl?: string;
  label?: string;
}

/**
 * Fast-path mirror for live HTML artifacts (`org/home/{decks,pages}/
 * <name>.html`). `write`/`edit` enqueue the full post-write content; the
 * cluster flush writes it server-side into org-fs, skipping the sandbox
 * mount's multi-second vfs write-back so the preview (and the change-feed
 * watcher) see the bytes at step end. Bash-created artifacts skip this and
 * are caught by the watcher after write-back.
 */
export interface HtmlArtifactBuffer {
  enqueue(rawPath: string, content: string): void;
  flush(): Promise<void>;
}

export interface VmToolsParams {
  /**
   * Narrow daemon hooks. Handle resolution, daemon-reachability detection, and
   * auto-restart retry live inside these closures, so the tools stay
   * independent of sandbox lifecycle and transport details.
   */
  readonly fs: SandboxFsHooks;
  /** Optional HTML-artifact fast-path mirror (hosted-only; see `HtmlArtifactBuffer`). */
  readonly htmlArtifactBuffer?: HtmlArtifactBuffer;
  readonly toolOutputMap: Map<string, string>;
  readonly needsApproval: boolean;
  /**
   * Shared queue for vision inputs that should be injected into the next
   * model turn. The `read` tool pushes here when it loads an image; the
   * queue is flushed by `prepareStep` in dispatch-run.ts.
   */
  readonly pendingImages: PendingImage[];
}
