export interface KeyedSerialTaskQueue {
  /** Run after every task already submitted for `key`. A rejection is returned
   * to its caller but never poisons later work. Different keys stay parallel. */
  run<T>(key: string, task: () => Promise<T>): Promise<T>;
  activeKeyCount(): number;
}

/** A FIFO registry that retains only keys with active or queued work. */
export function createKeyedSerialTaskQueue(): KeyedSerialTaskQueue {
  const tails = new Map<string, Promise<void>>();

  return {
    run<T>(key: string, task: () => Promise<T>): Promise<T> {
      const result = (tails.get(key) ?? Promise.resolve()).then(task);
      const tail = result.then(
        () => undefined,
        () => undefined,
      );
      tails.set(key, tail);
      void tail.then(() => {
        if (tails.get(key) === tail) tails.delete(key);
      });
      return result;
    },
    activeKeyCount: () => tails.size,
  };
}

// Module lifetime deliberately outlives a Settings panel. Navigating away
// flushes its trailing save; reopening the same project must queue behind it.
const sharedSaveQueue = createKeyedSerialTaskQueue();

export function runSerializedTask<T>(
  key: string,
  task: () => Promise<T>,
): Promise<T> {
  return sharedSaveQueue.run(key, task);
}
