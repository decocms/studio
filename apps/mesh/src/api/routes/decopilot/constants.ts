import { generatePrefixedId } from "@/shared/utils/generate-id";
export {
  DEFAULT_THREAD_TITLE,
  DEFAULT_WINDOW_SIZE,
  PARENT_STEP_LIMIT,
  buildBasePlatformPrompt,
  buildDecopilotAgentPrompt,
  buildRepoEnvironmentPrompt,
  buildTodoWritePrompt,
} from "@/harnesses/decopilot/prompt-constants";

/** Message ID generator. Use as closure where a () => string is expected (e.g. toUIMessageStreamResponse). */
export const generateMessageId = () => generatePrefixedId("msg");

export const DEFAULT_MAX_TOKENS = 32768;

export const SUBAGENT_STEP_LIMIT = 15;
