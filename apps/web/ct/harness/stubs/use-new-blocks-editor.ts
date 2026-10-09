/**
 * CT stub for `@/hooks/use-new-blocks-editor`.
 *
 * The real hook gives v8 sites the new editor and v7 ones the
 * `new_blocks_editor` org flag, reading the site's content backend and the org
 * settings, which need the full app provider tree this harness doesn't mount. Specs pick the editor by writing {@link NEW_BLOCKS_EDITOR_KEY}
 * before mounting (absent reads as off, like an unset flag); harnesses flip it
 * mid-test with {@link setNewBlocksEditor}.
 */
import { type ReactNode, useSyncExternalStore } from "react";

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

export function useNewBlocksEditorState(): boolean | undefined {
  return useNewBlocksEditor();
}

/** No site to detect here: the stored choice stands for every site. */
export function NewBlocksEditorProvider({ children }: { children: ReactNode }) {
  return children;
}
