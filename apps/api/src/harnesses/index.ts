// Decopilot is the only hosted runtime. Local CLI runs happen in the Tauri
// desktop app (`apps/native`, its own Rust harness crate).
export { streamDecopilot } from "@/harnesses/decopilot";
export { createSecretModelSource } from "@/harnesses/lib/types";
export type {
  ChatMessage,
  ChatMode,
  DecopilotSecretModelSource,
  DecopilotSecretModelSources,
  DecopilotStreamInput,
  HarnessUserContext,
  ModelSelection,
  ModelsConfig,
  ToolApprovalLevel,
} from "@/harnesses/lib/types";
