/**
 * Chat Context — consumer hooks from split provider architecture.
 *
 * Use the specific hooks for fine-grained subscriptions:
 *   useChatStream() — messages, status, streaming state (under ActiveTaskProvider)
 *   useChatTask() — tasks, navigation, virtualMcpId (under TaskProvider)
 *   useChatPrefs() — model selection, app contexts, tiptap (under TaskProvider)
 *   useChatBridge() — bridge to active task's sendMessage (under TaskProvider)
 */

export {
  ChatContextProvider,
  ActiveTaskProvider,
  useChatTask,
  useChatStream,
  useOptionalChatStream,
  useChatPrefs,
  useChatBridge,
  type ChatStreamContextValue,
  type ChatTaskContextValue,
  type ChatPrefsContextValue,
  type ChatBridgeValue,
} from "./chat-context";
