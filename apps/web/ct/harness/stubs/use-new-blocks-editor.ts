/**
 * CT stub for `@/hooks/use-new-blocks-editor`.
 *
 * The real hook reads the `new_blocks_editor` org flag through
 * `useProjectContext()`, which needs the full app provider tree this harness
 * doesn't mount. Specs pick the editor by writing {@link NEW_BLOCKS_EDITOR_KEY}
 * before mounting (absent reads as off, like an unset flag); harnesses flip it
 * mid-test with {@link setNewBlocksEditor}.
 */
import { useSyncExternalStore } from "react";

export const NEW_BLOCKS_EDITOR_KEY = "ct:new-blocks-editor";

const listeners = new Set<() => void>();

function read(): boolean {
  return localStorage.getItem(NEW_BLOCKS_EDITOR_KEY) === "true";
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setNewBlocksEditor(enabled: boolean): void {
  localStorage.setItem(NEW_BLOCKS_EDITOR_KEY, String(enabled));
  for (const listener of listeners) listener();
}

export function useNewBlocksEditor(): boolean {
  return useSyncExternalStore(subscribe, read);
}
