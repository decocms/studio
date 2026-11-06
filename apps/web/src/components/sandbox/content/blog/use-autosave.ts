import { useRef, useState } from "react";
import { useContentFlushListener } from "@/components/sections-editor/content-sync";

const AUTOSAVE_DELAY = 700;

/**
 * Local draft state that persists via `save` after a debounce. Each edit
 * resets the timer, so the final value wins (stale timers are cleared before
 * they fire). Remount (via a `key` on the editor) re-seeds the draft.
 *
 * External re-seeding: when `initial` changes by reference (e.g. a batch
 * mutation patched this block's payload in the shared cache while it's open),
 * the draft re-seeds from it — but only once edits settle (no timer pending and no save in flight), so
 * we never clobber what the user is currently typing. This is the "adjust
 * state during render" pattern, same as the collection-switch reset upstream.
 *
 * On unmount, a pending timer may fire and call `save` one last time. This
 * is intentional: it ensures the user's final edit is persisted even on fast
 * navigation. TanStack's `mutate` is fire-and-forget so the call is safe
 * after the component unmounts.
 */
export function useAutosave<T, E = never>(
  initial: T,
  save: (value: T, edit?: E) => void,
  opts?: {
    delay?: number;
    isSaving?: boolean;
    /**
     * The draft was seeded from `initial` (on mount, and on each re-seed):
     * an editor keeping its own copy records which copy it now shows
     * (`useSaveBlock`'s `hold`).
     */
    onSeed?: () => void;
    /**
     * The first edit since the last save is made: what it is built on
     * (`useSaveBlock`'s `edited`), handed to `save` with the value. An editor
     * whose save hook outlives this form (it is remounted from the draft's
     * copy while an edit is pending) guards that edit by the copy it was
     * made on.
     */
    onEdit?: () => E | undefined;
    /** The project whose `settleContentEdits` sends a pending save at once. */
    content?: { orgSlug: string; virtualMcpId: string };
  },
): readonly [T, (next: T) => void, (next: T) => void, boolean] {
  const delay = opts?.delay ?? AUTOSAVE_DELAY;
  const isSaving = opts?.isSaving ?? false;
  const [draft, setDraft] = useState<T>(() => {
    opts?.onSeed?.();
    return initial;
  });
  const [seeded, setSeeded] = useState<T>(initial);
  // `pending` mirrors "a debounced save is scheduled" as state so the re-seed
  // below can read it during render — the timer id itself stays in a ref
  // (imperative, never read during render).
  const [pending, setPending] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const edit = useRef<{ made: E | undefined } | null>(null);
  // The pending timer's save, for a flush to send it now.
  const fire = useRef<(() => void) | null>(null);

  // Re-seed from external `initial` only once edits settle — not while a save is in flight, whose older echo would revert a newer edit.
  if (initial !== seeded) {
    setSeeded(initial);
    if (!pending && !isSaving) {
      setDraft(initial);
      opts?.onSeed?.();
    }
  }

  const update = (next: T) => {
    setDraft(next);
    setPending(true);
    if (!edit.current) edit.current = { made: opts?.onEdit?.() };
    if (timer.current) clearTimeout(timer.current);
    const run = () => {
      timer.current = null;
      fire.current = null;
      setPending(false);
      const made = edit.current?.made;
      edit.current = null;
      save(next, made);
    };
    fire.current = run;
    timer.current = setTimeout(run, delay);
  };

  useContentFlushListener(opts?.content ?? null, () => {
    if (!timer.current) return false;
    clearTimeout(timer.current);
    fire.current?.();
    return false;
  });

  // Update the draft WITHOUT scheduling a save, cancelling any pending one.
  // For callers that already persisted the value through another path (e.g.
  // an awaited `mutateAsync`) and only need the local draft to catch up — a
  // plain `update` here would fire a redundant write, and a stale pending
  // timer could clobber the just-persisted value.
  const sync = (next: T) => {
    setDraft(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    fire.current = null;
    edit.current = null;
    setPending(false);
  };

  // 4th value: whether a debounced save is scheduled — a save indicator needs this alongside the mutation's own isPending, or it shows "Saved" mid-debounce.
  return [draft, update, sync, pending] as const;
}
