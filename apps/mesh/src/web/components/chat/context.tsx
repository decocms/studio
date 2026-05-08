/**
 * Chat Context — consumer hooks from merged provider architecture.
 *
 * Use the specific hooks for fine-grained subscriptions:
 *   useChatStream() — messages, status, streaming state
 *   useChatTask() — tasks, navigation, virtualMcpId
 *   useChatPrefs() — model selection, app contexts, tiptap
 */

export {
  ChatContextProvider as ChatProvider,
  ChatPrefsProvider,
  ActiveTaskProvider,
  useChatBridge,
  useChatTask,
  useOptionalChatTask,
  useChatStream,
  useOptionalChatStream,
  useChatPrefs,
  useOptionalChatPrefs,
  type ChatStreamContextValue,
  type ChatTaskContextValue,
  type ChatPrefsContextValue,
  type ChatBridgeValue,
} from "./chat-context";
