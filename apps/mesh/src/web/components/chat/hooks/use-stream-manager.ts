/**
 * useStreamManager — task-scoped SSE subscription + stream resume logic.
 *
 * Listens for SSE events on the active task and resumes disconnected streams.
 */

import { useRef, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useProjectContext, type ThreadDisplayStatus } from "@decocms/mesh-sdk";
import type { UseChatHelpers } from "@ai-sdk/react";
import { useDecopilotEvents } from "../../../hooks/use-decopilot-events";
import { KEYS } from "../../../lib/query-keys";
import type { ChatMessage } from "../types";

const MAX_RESUME_RETRIES = 3;

export function useStreamManager(
  threadId: string,
  chat: UseChatHelpers<ChatMessage>,
  threadStatus: ThreadDisplayStatus | undefined,
) {
  const { locator, org } = useProjectContext();
  const queryClient = useQueryClient();

  // Per-mount in-flight guard (NOT module-scoped — useChat is per-mount, not
  // shared by id). StrictMode double-mount fires /attach twice; server treats
  // concurrent attaches as idempotent JetStream reads.
  const resumeInFlightRef = useRef(false);
  const resumeFailCountRef = useRef(0);
  const prevThreadIdRef = useRef(threadId);
  if (prevThreadIdRef.current !== threadId) {
    prevThreadIdRef.current = threadId;
    resumeFailCountRef.current = 0;
    resumeInFlightRef.current = false;
  }

  const invalidateThreadList = () => {
    queryClient.invalidateQueries({ queryKey: KEYS.tasksPrefix(locator) });
  };

  const invalidateMessages = () => {
    if (!threadId) return;
    queryClient.invalidateQueries({
      predicate: (query) => {
        const key = query.queryKey;
        if (key[3] !== "collection" || key[4] !== "THREAD_MESSAGES")
          return false;
        const serialized = typeof key[6] === "string" ? key[6] : "";
        return serialized.includes(threadId);
      },
    });
  };

  const invalidateThreadOutputs = () => {
    if (!threadId) return;
    queryClient.invalidateQueries({
      queryKey: KEYS.threadOutputs(threadId),
    });
  };

  const isChatActive = () =>
    chat.status === "submitted" || chat.status === "streaming";

  const tryResumeStream = (reason: string) => {
    if (!threadId) return;
    if (resumeInFlightRef.current) return;
    if (resumeFailCountRef.current >= MAX_RESUME_RETRIES) return;
    if (isChatActive()) return;
    resumeInFlightRef.current = true;

    console.log(`[chat] resumeStream (${reason})`, threadId);
    chat
      .resumeStream()
      .then(() => {
        resumeInFlightRef.current = false;
        resumeFailCountRef.current = 0;
      })
      .catch((err: unknown) => {
        console.error("[chat] resumeStream error", err);
        resumeFailCountRef.current++;
        resumeInFlightRef.current = false;
        invalidateThreadList();
        invalidateMessages();
      });
  };

  // Auto-resume on mount / task switch. "expired" = stuck in-progress runs.
  // Triggered via useSyncExternalStore.subscribe so the kick-off runs post-mount,
  // avoiding React's "state update on unmounted component" warning when /attach
  // returns 204 fast in StrictMode. Subscribe identity is stable per-threadId;
  // tryResumeStream is read through a ref so subscribe sees the latest closure.
  const tryResumeStreamRef = useRef(tryResumeStream);
  tryResumeStreamRef.current = tryResumeStream;
  const threadStatusRef = useRef(threadStatus);
  threadStatusRef.current = threadStatus;

  const autoResumeSubscribeRef = useRef<
    ((onChange: () => void) => () => void) | null
  >(null);
  const autoResumeSubscribeThreadRef = useRef<string | null>(null);
  if (autoResumeSubscribeThreadRef.current !== threadId) {
    autoResumeSubscribeThreadRef.current = threadId;
    autoResumeSubscribeRef.current = (_onChange: () => void) => {
      const s = threadStatusRef.current;
      if (threadId && (s === "in_progress" || s === "expired")) {
        tryResumeStreamRef.current("auto-mount-or-status");
      }
      return () => {};
    };
  }
  useSyncExternalStore(
    autoResumeSubscribeRef.current!,
    () => threadId,
    () => threadId,
  );

  // Task-scoped SSE (for stream resume on this specific task)
  useDecopilotEvents({
    orgSlug: org.slug,
    taskId: threadId,
    onStep: () => tryResumeStream("sse-step"),
    onFinish: () => {
      // Always refresh download chips — fires for both active and resume
      // paths. Cheap (one GET, prefix-scoped listing).
      invalidateThreadOutputs();
      if (!isChatActive()) {
        resumeInFlightRef.current = false;
        resumeFailCountRef.current = 0;
        invalidateThreadList();
        setTimeout(invalidateMessages, 2000);
      }
    },
    onTaskStatus: () => {
      if (!isChatActive()) {
        invalidateThreadList();
      }
    },
  });
}
