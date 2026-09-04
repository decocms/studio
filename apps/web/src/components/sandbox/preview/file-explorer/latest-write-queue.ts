interface WriteWaiter {
  resolve: () => void;
  reject: (error: unknown) => void;
}

interface QueuedWrite<TValue> {
  value: TValue;
  write: (value: TValue) => Promise<void>;
  waiters: WriteWaiter[];
}

interface WriteSlot<TValue> {
  running: boolean;
  pending: QueuedWrite<TValue> | null;
  idle: Promise<void>;
  resolveIdle: () => void;
}

export class WriteQueueFencedError extends Error {
  constructor() {
    super("Writes for this path are temporarily fenced");
    this.name = "WriteQueueFencedError";
  }
}

/**
 * Runs at most one write per key while retaining only the newest queued value.
 * Callers whose not-yet-started value is superseded settle with the write that
 * replaced it, because that newer value is the durable outcome they requested
 * this queue to converge on.
 */
export class LatestWriteQueue<TKey, TValue> {
  private readonly slots = new Map<TKey, WriteSlot<TValue>>();
  private readonly fences = new Set<(key: TKey) => boolean>();
  private mutationTail: Promise<void> = Promise.resolve();

  enqueue(
    key: TKey,
    value: TValue,
    write: (value: TValue) => Promise<void>,
  ): Promise<void> {
    if ([...this.fences].some((matches) => matches(key))) {
      return Promise.reject(new WriteQueueFencedError());
    }
    return new Promise<void>((resolve, reject) => {
      let slot = this.slots.get(key);
      if (!slot) {
        let resolveIdle: () => void = () => {};
        const idle = new Promise<void>((done) => {
          resolveIdle = done;
        });
        slot = { running: false, pending: null, idle, resolveIdle };
        this.slots.set(key, slot);
      }

      const waiter = { resolve, reject };
      slot.pending = slot.pending
        ? {
            value,
            write,
            waiters: [...slot.pending.waiters, waiter],
          }
        : { value, write, waiters: [waiter] };

      if (!slot.running) void this.drain(key, slot);
    });
  }

  /**
   * Atomically rejects new matching writes, drains every already-accepted
   * matching write, then runs a conflicting filesystem mutation. Nested or
   * overlapping fences remain effective until their own action settles.
   */
  async withFence<TResult>(
    matches: (key: TKey) => boolean,
    action: () => Promise<TResult>,
  ): Promise<TResult> {
    this.fences.add(matches);
    const previousMutation = this.mutationTail;
    let releaseMutation: () => void = () => {};
    this.mutationTail = new Promise<void>((done) => {
      releaseMutation = done;
    });
    try {
      const active = [...this.slots]
        .filter(([key]) => matches(key))
        .map(([, slot]) => slot.idle);
      await previousMutation;
      await Promise.all(active);
      return await action();
    } finally {
      this.fences.delete(matches);
      releaseMutation();
    }
  }

  private async drain(key: TKey, slot: WriteSlot<TValue>): Promise<void> {
    slot.running = true;
    while (slot.pending) {
      const current = slot.pending;
      slot.pending = null;
      try {
        await current.write(current.value);
        for (const waiter of current.waiters) waiter.resolve();
      } catch (error) {
        for (const waiter of current.waiters) waiter.reject(error);
      }
    }
    slot.running = false;
    slot.resolveIdle();
    if (this.slots.get(key) === slot) this.slots.delete(key);
  }
}
