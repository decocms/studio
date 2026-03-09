/**
 * Daemon Client
 *
 * WebSocket client for real-time file system operations with the deco daemon.
 * Provides file read/write/delete operations and real-time change notifications.
 */

export interface DaemonConfig {
  siteUrl: string;
  env: string;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onError?: (error: Error) => void;
}

export type DaemonEventType =
  | "fs-sync"
  | "fs-snapshot"
  | "meta-info"
  | "worker-status";

export interface DaemonEvent {
  type: DaemonEventType;
  detail: unknown;
  timestamp?: number;
}

export interface FsSyncEvent extends DaemonEvent {
  type: "fs-sync";
  detail: {
    filepath: string;
    content?: string;
    deleted?: boolean;
  };
}

export interface MetaInfoEvent extends DaemonEvent {
  type: "meta-info";
  detail: {
    version: string;
    namespace: string;
    site: string;
    etag: string;
    timestamp: number;
    schema: Record<string, unknown>;
    manifest: {
      blocks: Record<string, Record<string, unknown>>;
    };
  };
}

/**
 * DaemonClient provides real-time file system access to a deco site.
 *
 * @example
 * ```ts
 * const daemon = new DaemonClient({
 *   siteUrl: 'https://mysite.deco.site',
 *   env: 'staging',
 * });
 *
 * // Watch for changes
 * for await (const event of daemon.watch()) {
 *   console.log('File changed:', event);
 * }
 * ```
 */
export class DaemonClient {
  private abortController: AbortController | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectDelay = 1000;

  constructor(private config: DaemonConfig) {}

  /**
   * Start watching for file system changes.
   * Returns an async iterator that yields events.
   */
  async *watch(): AsyncIterableIterator<DaemonEvent> {
    const { siteUrl, env } = this.config;
    this.abortController = new AbortController();

    try {
      const watchUrl = `${siteUrl}/live/invoke/website/loaders/daemon/watch.ts`;
      const url = new URL(watchUrl);
      url.searchParams.set("env", env);
      url.searchParams.set("since", "0");

      const response = await fetch(url.toString(), {
        signal: this.abortController.signal,
        headers: {
          Accept: "text/event-stream",
        },
      });

      if (!response.ok) {
        throw new Error(`Daemon connection failed: ${response.status}`);
      }

      this.config.onConnect?.();
      this.reconnectAttempts = 0;

      const reader = response.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const event = JSON.parse(line.slice(6)) as DaemonEvent;
              yield event;
            } catch {
              // Skip invalid JSON
            }
          }
        }
      }
    } catch (error) {
      if ((error as Error).name !== "AbortError") {
        this.config.onError?.(error as Error);
        throw error;
      }
    } finally {
      this.config.onDisconnect?.();
    }
  }

  /**
   * Read a file from the site's file system.
   */
  async readFile(path: string): Promise<string> {
    const { siteUrl, env } = this.config;
    const url = `${siteUrl}/live/invoke/website/loaders/daemon/fs/read.ts`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, env }),
    });

    if (!response.ok) {
      throw new Error(`Failed to read file: ${response.status}`);
    }

    const data = await response.json();
    return data.content;
  }

  /**
   * Write content to a file in the site's file system.
   */
  async writeFile(path: string, content: string): Promise<void> {
    const { siteUrl, env } = this.config;
    const url = `${siteUrl}/live/invoke/website/actions/daemon/fs/write.ts`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, content, env }),
    });

    if (!response.ok) {
      throw new Error(`Failed to write file: ${response.status}`);
    }
  }

  /**
   * Delete a file from the site's file system.
   */
  async deleteFile(path: string): Promise<void> {
    const { siteUrl, env } = this.config;
    const url = `${siteUrl}/live/invoke/website/actions/daemon/fs/delete.ts`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, env }),
    });

    if (!response.ok) {
      throw new Error(`Failed to delete file: ${response.status}`);
    }
  }

  /**
   * List files in a directory.
   */
  async listFiles(prefix?: string): Promise<string[]> {
    const { siteUrl, env } = this.config;
    const url = `${siteUrl}/live/invoke/website/loaders/daemon/fs/ls.ts`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prefix, env }),
    });

    if (!response.ok) {
      throw new Error(`Failed to list files: ${response.status}`);
    }

    const data = await response.json();
    return data.files;
  }

  /**
   * Disconnect from the daemon.
   */
  disconnect(): void {
    this.abortController?.abort();
    this.abortController = null;
  }

  /**
   * Reconnect to the daemon.
   */
  reconnect(): void {
    this.disconnect();
    // The watch() generator should be restarted by the caller
  }
}

