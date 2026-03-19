/**
 * ChatBridge — thin adapter between useAIChat and ChatStore.
 *
 * This is the ONLY place `useChat` from `@ai-sdk/react` lives.
 * It syncs the AI SDK's streaming output into the store and exposes
 * chat methods (sendMessage, stop, etc.) back to the store.
 */

import { useChat as useAIChat } from "@ai-sdk/react";
import {
  lastAssistantMessageIsCompleteWithToolCalls,
  lastAssistantMessageIsCompleteWithApprovalResponses,
} from "ai";
import { useEffect } from "react";
import { useInvalidateCollectionsOnToolCall } from "../../hooks/use-invalidate-collections-on-tool-call";
import { chatStore } from "./store/chat-store";
import { useActiveThreadId, useChatMessages } from "./store/selectors";
import type { ChatMessage } from "./types";

export function ChatBridge() {
  const activeThreadId = useActiveThreadId();
  const messages = useChatMessages();
  const onToolCall = useInvalidateCollectionsOnToolCall();

  const chat = useAIChat<ChatMessage>({
    id: activeThreadId,
    messages,
    transport: chatStore.getTransport(),
    sendAutomaticallyWhen: ({ messages }) =>
      lastAssistantMessageIsCompleteWithToolCalls({ messages }) ||
      lastAssistantMessageIsCompleteWithApprovalResponses({ messages }),
    onFinish: (payload) => chatStore.onFinish(payload),
    onToolCall: onToolCall as never,
    onError: (error) => chatStore.onError(error),
    onData: ({ data, type }) => {
      if (type === "data-thread-title") {
        const { title } = data;
        if (!title) return;
        chatStore.renameThreadLocally(activeThreadId, title);
      }
    },
  });

  // Sync store after render to avoid "cannot update component while rendering
  // another" warnings — store mutations call notify() which triggers
  // useSyncExternalStore listeners synchronously.
  // oxlint-disable-next-line ban-use-effect/ban-use-effect
  useEffect(() => {
    if (chat.status !== "ready") {
      chatStore.onStreamMessages(chat.messages);
    }
    chatStore.onStatusChange(chat.status);

    chatStore.registerChatBridge({
      sendMessage: chat.sendMessage,
      stop: chat.stop,
      setMessages: chat.setMessages,
      resumeStream: chat.resumeStream,
      addToolOutput: chat.addToolOutput,
      addToolApprovalResponse: chat.addToolApprovalResponse,
    });
  });

  return null;
}
