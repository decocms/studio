import type {
  DecopilotHttpMcpSource,
  DecopilotObjectStorageSource,
  DecopilotSecretModelSources,
  ChatMessage,
  HarnessStreamInput,
  HarnessUserContext,
} from "../types";

export interface DecopilotRunContext {
  taskId?: string;
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
  mcpSource?: DecopilotHttpMcpSource;
  objectStorageSource?: DecopilotObjectStorageSource;
  userContext?: HarnessUserContext;
}

const runContexts = new WeakMap<object, DecopilotRunContext>();

export function setDecopilotRunContext(
  input: object,
  context: DecopilotRunContext,
): void {
  runContexts.set(input, context);
}

export function getDecopilotRunContext(
  input: HarnessStreamInput,
): DecopilotRunContext | undefined {
  return runContexts.get(input);
}

export function requireDecopilotRunContext(
  input: HarnessStreamInput,
): DecopilotRunContext {
  const context = getDecopilotRunContext(input);
  if (!context) {
    throw new Error(
      "Decopilot requires process-local run context. Dispatch must attach " +
        "DecopilotRunContext before invoking the Decopilot harness.",
    );
  }
  return context;
}
