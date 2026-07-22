/**
 * Open the Preview tab the moment `load_repo` succeeds in this chat.
 *
 * The tool emits a transient `data-open-preview` stream chunk (handled in
 * chat-context's observer) which opens the tab live — but a chunk is only seen
 * by the client that is actively streaming the run. Someone VIEWING the chat of
 * a background Super Agent run (opened from the task board's activity card) or
 * reopening a finished run never receives it, so the tab never opens.
 *
 * This is the durable counterpart: it scans the persisted messages for a
 * successful `load_repo` tool result (`tool-load_repo`, `output-available`,
 * `output.success`) and opens `?main=preview`. Fires once per thread and is
 * guarded so it never fights a manual switch away from Preview afterwards.
 */

import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { useOptionalChatStream, useOptionalChatTask } from "./context";

export function useOpenPreviewOnRepoLoad(): void {
  const navigate = useNavigate();
  const messages = useOptionalChatStream()?.messages ?? [];
  const taskId = useOptionalChatTask()?.taskId ?? null;

  const repoLoaded = messages.some((m) =>
    m.parts?.some((p) => {
      const part = p as {
        type: string;
        state?: string;
        output?: { success?: boolean };
      };
      return (
        part.type === "tool-load_repo" &&
        part.state === "output-available" &&
        part.output?.success === true
      );
    }),
  );

  const openedFor = useRef<string | null>(null);

  // oxlint-disable-next-line ban-use-effect/ban-use-effect -- navigation side effect on a durable stream signal
  useEffect(() => {
    if (!repoLoaded || !taskId || openedFor.current === taskId) return;
    openedFor.current = taskId;
    navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({ ...prev, main: "preview" }),
      replace: true,
    });
  }, [repoLoaded, taskId, navigate]);
}
