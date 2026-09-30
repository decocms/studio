export type Decofile = Record<string, unknown>;

/** Block key → its JSON, the form a block is compared in. */
export type DecofileSnapshot = Map<string, string>;

export interface OverlayPatch {
  set?: Decofile;
  delete?: string[];
}

export function snapshotDecofile(decofile: Decofile): DecofileSnapshot {
  const snapshot: DecofileSnapshot = new Map();
  for (const [key, value] of Object.entries(decofile)) {
    const json = JSON.stringify(value);
    if (json !== undefined) snapshot.set(key, json);
  }
  return snapshot;
}

/** The blocks that changed or disappeared since `sent`; `null` when none did. */
export function diffDecofile(
  sent: DecofileSnapshot,
  next: Decofile,
): { patch: OverlayPatch | null; snapshot: DecofileSnapshot } {
  const snapshot = snapshotDecofile(next);
  const set: Decofile = {};
  for (const [key, json] of snapshot) {
    if (sent.get(key) !== json) set[key] = next[key];
  }
  const deleted = [...sent.keys()].filter((key) => !snapshot.has(key));
  const patch: OverlayPatch = {};
  if (Object.keys(set).length > 0) patch.set = set;
  if (deleted.length > 0) patch.delete = deleted;
  return {
    patch: patch.set || patch.delete ? patch : null,
    snapshot,
  };
}

interface Broadcast {
  sent: DecofileSnapshot;
  send: (patch: OverlayPatch) => Promise<void>;
  onError: (error: unknown) => void;
}

/**
 * Pushes editor edits to a preview session: debounced, one request in flight,
 * and an edit that lands mid-flight goes out right after it. A failed patch
 * leaves `sent` untouched, so its blocks ride along with the next edit.
 */
export function createOverlaySync(debounceMs = 300) {
  let broadcast: Broadcast | null = null;
  let latest: Decofile | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight = false;
  let queued = false;

  const flush = async () => {
    timer = undefined;
    const current = broadcast;
    if (!current || !latest) return;
    if (inFlight) {
      queued = true;
      return;
    }
    const { patch, snapshot } = diffDecofile(current.sent, latest);
    if (!patch) return;
    inFlight = true;
    try {
      await current.send(patch);
      current.sent = snapshot;
    } catch (error) {
      if (broadcast === current) current.onError(error);
    } finally {
      inFlight = false;
    }
    if (queued) {
      queued = false;
      await flush();
    }
  };

  return {
    /** Starts broadcasting; `baseline` is what the session already shows. */
    start(
      baseline: Decofile,
      send: Broadcast["send"],
      onError: Broadcast["onError"],
    ) {
      broadcast = { sent: snapshotDecofile(baseline), send, onError };
      latest = baseline;
    },
    update(decofile: Decofile) {
      if (!broadcast) return;
      latest = decofile;
      clearTimeout(timer);
      timer = setTimeout(() => void flush(), debounceMs);
    },
    stop() {
      clearTimeout(timer);
      broadcast = null;
      latest = null;
      queued = false;
    },
  };
}
