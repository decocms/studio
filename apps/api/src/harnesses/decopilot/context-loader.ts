import { DEFAULT_WINDOW_SIZE } from "@/api/routes/decopilot/constants";
import { resolveStorageRefs } from "@/api/routes/decopilot/file-materializer";
import { createMemory } from "@/api/routes/decopilot/memory";
import type { ChatMessage } from "@/api/routes/decopilot/types";
import type { StudioContext } from "@/core/studio-context";
import type { ThreadMessage } from "@/storage/types";

function mergeHistoryWithUserMessage(
  history: ThreadMessage[] | ChatMessage[],
  userMessage: ChatMessage,
): ChatMessage[] {
  const validHistory = history.filter((m) => m.parts && m.parts.length > 0);
  const matchIndex = validHistory.findIndex((m) => m.id === userMessage.id);
  const conversation =
    matchIndex >= 0
      ? [...validHistory.slice(0, matchIndex), userMessage]
      : [...validHistory, userMessage];
  return conversation as ChatMessage[];
}

export async function assembleDecopilotContextForTest(input: {
  history: ChatMessage[];
  userMessage: ChatMessage;
  systemMessages: ChatMessage[];
}): Promise<ChatMessage[]> {
  return [
    ...input.systemMessages,
    ...mergeHistoryWithUserMessage(input.history, input.userMessage),
  ];
}

export async function loadDecopilotContext(input: {
  ctx: StudioContext;
  threadId: string;
  userMessage: ChatMessage;
  windowSize: number | undefined;
  isSubagent: boolean;
  systemMessages: ChatMessage[];
}): Promise<ChatMessage[]> {
  const history = input.isSubagent
    ? []
    : await (
        await createMemory(input.ctx.storage.threads, {
          threadId: input.threadId,
          defaultWindowSize: input.windowSize ?? DEFAULT_WINDOW_SIZE,
        })
      ).loadHistory(input.windowSize ?? DEFAULT_WINDOW_SIZE);

  const assembled = await assembleDecopilotContextForTest({
    history: history as ChatMessage[],
    userMessage: input.userMessage,
    systemMessages: input.systemMessages,
  });
  return resolveStorageRefs(assembled, input.ctx);
}
