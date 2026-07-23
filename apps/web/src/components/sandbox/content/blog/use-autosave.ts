import { useRef, useState } from "react";

const AUTOSAVE_DELAY = 700;

/**
 * Local draft state that persists via `save` after a debounce. Each edit
 * resets the timer, so the final value wins (stale timers are cleared before
 * they fire). Remount (via a `key` on the editor) re-seeds the draft.
 *
 * External re-seeding: when `initial` changes by reference (e.g. a batch
 * mutation patched this block's payload in the shared cache while it's open),
 * the draft re-seeds from it — but only when there's no pending local edit, so
 * we never clobber what the user is currently typing. This is the "adjust
 * state during render" pattern, same as the collection-switch reset upstream.
 *
 * On unmount, a pending timer may fire and call `save` one last time. This
 * is intentional: it ensures the user's final edit is persisted even on fast
 * navigation. TanStack's `mutate` is fire-and-forget so the call is safe
 * after the component unmounts.
 */
export function useAutosave<T>(
  initial: T,
  save: (value: T) => void,
  delay = AUTOSAVE_DELAY,
): readonly [T, (next: T) => void, (next: T) => void] {
  const [draft, setDraft] = useState<T>(initial);
  const [seeded, setSeeded] = useState<T>(initial);
  // `pending` mirrors "a debounced save is scheduled" as state so the re-seed
  // below can read it during render — the timer id itself stays in a ref
  // (imperative, never read during render).
  const [pending, setPending] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Re-seed from an external change to `initial` when no local edit is pending.
  if (initial !== seeded) {
    setSeeded(initial);
    if (!pending) setDraft(initial);
  }

  const update = (next: T) => {
    setDraft(next);
    setPending(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      setPending(false);
      save(next);
    }, delay);
  };

  // Update the draft WITHOUT scheduling a save, cancelling any pending one.
  // For callers that already persisted the value through another path (e.g.
  // an awaited `mutateAsync`) and only need the local draft to catch up — a
  // plain `update` here would fire a redundant write, and a stale pending
  // timer could clobber the just-persisted value.
  const sync = (next: T) => {
    setDraft(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setPending(false);
  };

  return [draft, update, sync] as const;
}
