const DEFAULT_MAX_PENDING_CODE_UNITS = 4_096;

interface TerminalInputCoalescerOptions {
  maxPendingCodeUnits?: number;
  schedule?: (callback: () => void) => void;
}

/**
 * Preserve immediate key latency while collapsing dense same-turn input such
 * as the SGR mouse reports emitted for one trackpad gesture.
 */
export class TerminalInputCoalescer {
  private readonly write: (data: string) => void;
  private readonly maxPendingCodeUnits: number;
  private readonly schedule: (callback: () => void) => void;

  private pending = "";
  private coalescing = false;
  private generation = 0;

  constructor(
    write: (data: string) => void,
    options: TerminalInputCoalescerOptions = {},
  ) {
    this.write = write;
    this.maxPendingCodeUnits = Math.max(
      1,
      options.maxPendingCodeUnits ?? DEFAULT_MAX_PENDING_CODE_UNITS,
    );
    this.schedule =
      options.schedule ?? ((callback: () => void) => queueMicrotask(callback));
  }

  enqueue(data: string): void {
    if (!data) return;

    if (!this.coalescing) {
      this.coalescing = true;
      this.write(data);
      const generation = this.generation;
      this.schedule(() => {
        if (generation !== this.generation) return;
        this.flushPending();
        this.coalescing = false;
      });
      return;
    }

    if (this.pending.length + data.length > this.maxPendingCodeUnits) {
      this.flushPending();
    }
    if (data.length > this.maxPendingCodeUnits) {
      this.write(data);
      return;
    }
    this.pending += data;
  }

  /** Flush queued bytes before a non-input control frame is sent. */
  flush(): void {
    this.flushPending();
  }

  /** Drop bytes that belong to a socket/session that is no longer writable. */
  clear(): void {
    this.pending = "";
    this.coalescing = false;
    this.generation++;
  }

  private flushPending(): void {
    if (!this.pending) return;
    const data = this.pending;
    this.pending = "";
    this.write(data);
  }
}
