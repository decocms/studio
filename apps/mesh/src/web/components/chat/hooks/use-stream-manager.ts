/**
 * useStreamManager — task-scoped SSE subscription + stream resume logic.
 *
 * Owns every decision about *when* to call `chat.resumeStream()`. Three
 * triggers feed in:
 *
 *   1. Mount / task switch with a server-side in-flight run
 *   2. `decopilot.step` events on the org-wide watch SSE (the run made
 *      progress server-side — pick the stream back up to render it)
 *   3. `chat.status` transitioning to "error" when the cause looks like a
 *      mid-stream connection cut (proxy idle/duration timeout, TCP RST,
 *      mid-byte UTF-8 truncation). The watch SSE is on a separate socket
 *      and may be in reconnect at the same moment, so we can't rely on
 *      it to deliver the next step event in a timely way.
 *
 * All three go through the same `tryResumeStream` gate (in-flight guard +
 * retry cap + active-chat check), so concurrent triggers can't fire two
 * /attach requests for the same task.
 */

import { useRef, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useProjectContext, type ThreadDisplayStatus } from "@decocms/mesh-sdk";
import type { UseChatHelpers } from "@ai-sdk/react";
import { useDecopilotEvents } from "../../../hooks/use-decopilot-events";
import { KEYS } from "../../../lib/query-keys";
import type { ChatMessage } from "../types";

const MAX_RESUME_RETRIES = 3;

/**
 * Discriminates "the wire broke" from "the server told us something is
 * wrong". The browser's fetch / Web Streams APIs throw `TypeError` for
 * every transport-level failure (TCP RST mid-stream, mid-byte UTF-8
 * truncation by `TextDecoderStream`, network unreachable, ...). The AI
 * SDK funnels server-emitted error chunks through `new Error(chunkText)`
 * and HTTP-error responses through `new Error(responseText)` — both plain
 * `Error`, not `TypeError`. AbortError is filtered by the AI SDK before
 * `chat.error` is populated, so explicit user stops never land here.
 *
 * Keeping this as an `instanceof` check (vs. matching browser-specific
 * message strings like "network error" / "Error in input stream" / "Load
 * failed") makes the discriminator browser-agnostic and avoids a
 * message-catalog that has to be kept in sync with browser releases.
 *
 * Auto-retrying app-level errors would be actively harmful: the credits
 * banner keys off the `[CREDITS]` prefix from `sanitizeStreamError`, and
 * if we cleared and re-set `chatError` while resuming through buffered
 * chunks the user would see it flicker on-and-off instead of staying
 * stable with the inline top-up.
 */
function isTransientStreamError(error: Error): boolean {
  return error instanceof TypeError;
}

const isRunInProgressStatus = (s: ThreadDisplayStatus | undefined): boolean =>
  s === "in_progress" || s === "expired";

export function useStreamManager(
  threadId: string,
  chat: UseChatHelpers<ChatMessage>,
  threadStatus: ThreadDisplayStatus | undefined,
  onResumeSuccess?: () => void,
): void {
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

  // Latest callback in a ref so the closure inside `tryResumeStream` always
  // sees the current function without forcing the subscribe identity to
  // change on every render.
  const onResumeSuccessRef = useRef(onResumeSuccess);
  onResumeSuccessRef.current = onResumeSuccess;

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
        // Successful resume — surface to the parent so it can clear any
        // "network error" banner left over from the disconnect that caused
        // this resume in the first place.
        try {
          onResumeSuccessRef.current?.();
        } catch (err) {
          // Callback errors are non-fatal — log but don't break the resume
          // bookkeeping above.
          console.error("[chat] onResumeSuccess threw", err);
        }
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

  // Detect `chat.status` transitioning *into* "error" with a transient-looking
  // cause while the server still says the run is in-flight, and fire a resume.
  // Detection happens in render (compare current vs. ref-tracked previous);
  // the resume itself is deferred to a microtask so React's commit completes
  // before we kick off another fetch. Reading status from the ref keeps the
  // detection idempotent across re-renders — only true status *transitions*
  // queue a resume, not every render while status === "error".
  const prevChatStatusRef = useRef(chat.status);
  if (
    prevChatStatusRef.current !== "error" &&
    chat.status === "error" &&
    chat.error &&
    isTransientStreamError(chat.error) &&
    isRunInProgressStatus(threadStatus)
  ) {
    queueMicrotask(() => tryResumeStreamRef.current("on-stream-error"));
  }
  prevChatStatusRef.current = chat.status;
}
