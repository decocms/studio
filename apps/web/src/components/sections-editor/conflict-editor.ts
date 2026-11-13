/**
 * The editor a refused hosted save carried (`draft[name].editor`), kept per
 * block and version of theirs for the conflict dialog (`conflict-author.ts`).
 * Its own module, with no React or app imports, so the content-protocol
 * client can record it.
 */

import type { QueryClient } from "@tanstack/react-query";
import { canonicalBlockJson } from "@decocms/shared/decofile";
import { KEYS } from "@/lib/query-keys";

/** One block's last change, as the dialog reads it (`at` an ISO time). */
export interface DraftEditor {
  userId: string;
  at: string;
}

/** A short, stable tag for one version of theirs (part of the query key). */
export function versionTag(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = (Math.imul(h2, 31) + c) | 0;
  }
  return `${(h1 >>> 0).toString(36)}${(h2 >>> 0).toString(36)}:${text.length}`;
}

/**
 * Keeps the editor a refused hosted save carried for `blockKey`'s version of
 * theirs (`entry`, the refusal's `draft[blockKey]`), for the dialog that
 * shows that version. `at` comes in Unix seconds.
 */
export function rememberConflictEditor(
  queryClient: QueryClient,
  blockKey: string,
  entry: { block: unknown; editor?: unknown },
): void {
  const editor = entry.editor as
    | { userId?: unknown; at?: unknown }
    | null
    | undefined;
  const change: DraftEditor | null =
    editor &&
    typeof editor.userId === "string" &&
    typeof editor.at === "number" &&
    Number.isFinite(editor.at)
      ? {
          userId: editor.userId,
          at: new Date(editor.at * 1000).toISOString(),
        }
      : null;
  queryClient.setQueryData(
    KEYS.conflictEditor(
      blockKey,
      versionTag(canonicalBlockJson(entry.block ?? null)),
    ),
    change,
  );
}
