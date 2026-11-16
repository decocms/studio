/**
 * Runs `task` with `setPending(true)`, then resets it once the task settles,
 * including when it throws. Kept out of components: React Compiler skips a
 * component that contains `try/finally`.
 */
export async function whilePending<T>(
  setPending: (pending: boolean) => void,
  task: () => T | Promise<T>,
): Promise<T> {
  setPending(true);
  try {
    return await task();
  } finally {
    setPending(false);
  }
}
