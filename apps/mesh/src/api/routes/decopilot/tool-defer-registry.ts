/**
 * In-process registry of running "deferrable" tool calls (today: an inline
 * `subtask`). A tool registers its `toolCallId`; a "send to background" request
 * (local or fanned out by `ToolDeferBroadcast`) resolves the promise, and the
 * tool hands its work to a detached drain. Per-pod: only the pod running the
 * call holds a live registration; others `requestDefer` → `false` and no-op.
 */

interface Entry {
  resolve: () => void;
  promise: Promise<void>;
}

const registry = new Map<string, Entry>();

export interface DeferHandle {
  /** Resolves when a defer-to-background request arrives for this tool call. */
  readonly deferred: Promise<void>;
  /** Drop the registration — call when the tool finishes or hands off. */
  dispose(): void;
}

/** Register a running tool call as deferrable. */
export function registerDeferrable(toolCallId: string): DeferHandle {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  registry.set(toolCallId, { resolve, promise });
  return {
    deferred: promise,
    dispose: () => {
      registry.delete(toolCallId);
    },
  };
}

/**
 * Request that a running tool call defer to the background. Returns true when a
 * live registration existed on this pod (i.e. the tool runs here), false
 * otherwise — the broadcast caller uses neither, it's a signal for tests.
 */
export function requestDefer(toolCallId: string): boolean {
  const entry = registry.get(toolCallId);
  if (!entry) return false;
  entry.resolve();
  return true;
}
