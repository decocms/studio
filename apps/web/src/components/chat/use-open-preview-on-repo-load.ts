/**
 * Open the Preview tab — and re-read the thread row — when `load_repo` succeeds
 * in this chat.
 *
 * The tool emits a transient `data-open-preview` stream chunk (handled in
 * chat-context's observer) which opens the tab live AND patches the repo it
 * bound (`githubRepo` + `sandboxMap`) onto the local thread row — but a chunk is
 * only seen by the client that is actively streaming the run. Someone VIEWING
 * the chat of a background Super Agent run (opened from the task board's
 * activity card) or reopening a finished run never receives it, so the tab never
 * opens and the row keeps its pre-repo snapshot. That stale row makes the
 * preview show "no source to preview" even though the repo IS bound
 * server-side — the `/watch` thread-status event carries no metadata and
 * `useEnsureTask` short-circuits on the local row, so nothing else fills it in.
 *
 * This is the durable counterpart: it scans the persisted messages for a
 * successful `load_repo` tool result (`tool-load_repo`, `output-available`,
 * `output.success`), refreshes the thread's metadata from the server and opens
 * `?main=preview`. The tab opens once per thread (so it never fights a manual
 * switch away from Preview afterwards) while the metadata refresh re-runs on a
 * repo SWITCH — a second `load_repo` binds a different repo and sandbox.
 */

import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { useOptionalChatStream, useOptionalChatTask } from "./context";
import { useOptionalThreadManager } from "./store/hooks";

/** Successful `load_repo` calls in a message list. A COUNT, not a boolean, so a
 *  repo switch (a second load) is a distinct signal from the first load. */
export function countLoadedRepos(
  messages: readonly { parts?: unknown[] }[],
): number {
  let loads = 0;
  for (const message of messages) {
    for (const p of message.parts ?? []) {
      const part = p as {
        type?: string;
        state?: string;
        output?: { success?: boolean };
      };
      if (
        part.type === "tool-load_repo" &&
        part.state === "output-available" &&
        part.output?.success === true
      ) {
        loads++;
      }
    }
  }
  return loads;
}

export function useOpenPreviewOnRepoLoad(): void {
  const navigate = useNavigate();
  const manager = useOptionalThreadManager();
  const messages = useOptionalChatStream()?.messages ?? [];
  const taskId = useOptionalChatTask()?.taskId ?? null;

  const loads = countLoadedRepos(messages);

  const openedFor = useRef<string | null>(null);
  /** `<taskId>:<loads>` of the last refresh, so switching threads or loading a
   *  second repo re-reads, but a re-render at the same count does not. */
  const refreshedKey = useRef<string | null>(null);

  // oxlint-disable-next-line ban-use-effect/ban-use-effect -- navigation side effect on a durable stream signal
  useEffect(() => {
    if (!loads || !taskId) return;
    const key = `${taskId}:${loads}`;
    if (refreshedKey.current !== key) {
      refreshedKey.current = key;
      void manager?.refreshThreadMetadata(taskId);
    }
    if (openedFor.current === taskId) return;
    openedFor.current = taskId;
    navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({ ...prev, main: "preview" }),
      replace: true,
    });
  }, [loads, taskId, navigate, manager]);
}
