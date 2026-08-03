import type {
  DecopilotSecretModelSources,
  ChatMessage,
  HarnessUserContext,
} from "../types";

export interface DecopilotRunContext {
  isSubagent?: boolean;
  subtaskJobId?: string;
  resumedFromBackground?: boolean;
  virtualMcp: {
    id: string;
    metadata?: unknown;
  };
  branch?: string | null;
  messages?: ChatMessage[];
  modelSources?: DecopilotSecretModelSources;
  userContext?: HarnessUserContext;
}
