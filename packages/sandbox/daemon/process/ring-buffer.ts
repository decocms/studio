/**
 * Simple capped string buffer. Appends are amortised constant-time; reads
 * return everything currently held. When `appended > capacity` we keep the
 * tail (most-recent bytes) and surface a `truncated` flag.
 *
 * Used for the in-memory tail of job/app output; the file-backed log
 * stream owned by `LogTee` is the durable copy.
 */
export class RingBuffer {
  private chunks: string[] = [];
  private size = 0;
  private dropped = false;

  constructor(private readonly capacity: number) {}

  append(data: string): void {
    if (data.length === 0) return;
    this.chunks.push(data);
    this.size += data.length;
    while (this.size > this.capacity && this.chunks.length > 0) {
      const head = this.chunks[0];
      if (head === undefined) break;
      if (this.size - head.length >= this.capacity) {
        this.chunks.shift();
        this.size -= head.length;
        this.dropped = true;
        continue;
      }
      const overflow = this.size - this.capacity;
      this.chunks[0] = head.slice(overflow);
      this.size -= overflow;
      this.dropped = true;
      break;
    }
  }

  read(): { data: string; truncated: boolean } {
    return { data: this.chunks.join(""), truncated: this.dropped };
  }

  byteLength(): number {
    return this.size;
  }
}
