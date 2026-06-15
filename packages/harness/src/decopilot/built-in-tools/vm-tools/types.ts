import type { SandboxFsHooks } from "./sandbox-fs-hooks-types";

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

/**
 * Fast-path mirror for presentation decks (`org/<slug>/decks/<name>.html`).
 * `write`/`edit` enqueue the full post-write content; the cluster flush
 * writes it server-side into org-fs, skipping the sandbox mount's multi-
 * second vfs write-back so the preview (and the change-feed deck watcher)
 * see the bytes at step end. Bash-created decks skip this and are caught
 * by the watcher after write-back.
 */
export interface DeckBuffer {
  enqueue(rawPath: string, content: string): void;
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
  /** Optional deck fast-path mirror (cluster-only; see `DeckBuffer`). */
  readonly deckBuffer?: DeckBuffer;
  readonly toolOutputMap: Map<string, string>;
  readonly needsApproval: boolean;
  /**
   * Shared queue for vision inputs that should be injected into the next
   * model turn. The `read` tool pushes here when it loads an image; the
   * queue is flushed by `prepareStep` in dispatch-run.ts.
   */
  readonly pendingImages: PendingImage[];
  /**
   * Mesh context for tools that resolve the org id / object storage for
   * stable file URLs (and the deck fast-path mirror).
   */
  readonly ctx: VmToolContext;
  /** Current chat thread id (accepted for parity across callers). */
  readonly threadId: string;
  /**
   * Virtual MCP ID (accepted for parity across callers).
   */
  readonly virtualMcpId: string;
}
