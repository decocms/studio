/** Per-source bounded ring buffer (kept as a string, trimmed on append). */
export class ReplayBuffer {
  private buffers: Record<string, string> = {};
  constructor(private readonly maxBytes: number) {}

  append(source: string, data: string): void {
    if (!data) return;
    const prev = this.buffers[source] ?? "";
    const next = prev + data;
    this.buffers[source] =
      next.length > this.maxBytes
        ? next.slice(next.length - this.maxBytes)
        : next;
  }

  read(source: string): string {
    return this.buffers[source] ?? "";
  }

  sources(): string[] {
    return Object.keys(this.buffers);
  }
}
