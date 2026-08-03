import type { VirtualMCPEntity } from "@decocms/shared/sdk";
import type {
  DecopilotSecretModelSources,
  ChatMessage,
  HarnessUserContext,
} from "../types";

export interface DecopilotRunContext {
  isSubagent?: boolean;
  subtaskJobId?: string;
  resumedFromBackground?: boolean;
  virtualMcp: VirtualMCPEntity;
  branch?: string | null;
  messages?: ChatMessage[];
  modelSources?: DecopilotSecretModelSources;
  userContext?: HarnessUserContext;
}
