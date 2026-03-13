/**
 * Semaphore
 *
 * Simple in-memory concurrency limiter for bounding the number of
 * concurrent automation runs across the entire process.
 */

export class Semaphore {
  private current = 0;

  constructor(private max: number) {}

  tryAcquire(): { release: () => void } | null {
    if (this.current >= this.max) return null;
    this.current++;
    let released = false;
    return {
      release: () => {
        if (!released) {
          released = true;
          this.current--;
        }
      },
    };
  }

  get available(): number {
    return this.max - this.current;
  }
}
