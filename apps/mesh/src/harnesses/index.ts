import { claudeCodeHarnessFactory } from "./claude-code";
import { codexHarnessFactory } from "./codex";
import { decopilotHarnessFactory } from "./decopilot";
import { registerHarnessFactory } from "./registry";

// Side-effect registration. Importing this module wires up the three
// in-tree harnesses. Out-of-tree harnesses register themselves the same way.
//
// CLI harnesses (claude-code, codex) are also imported by the desktop link
// daemon; decopilot pulls in cluster-only modules (RunRegistry, run-stream,
// mesh tools) and is only usable on the cluster side.
registerHarnessFactory(decopilotHarnessFactory);
registerHarnessFactory(claudeCodeHarnessFactory);
registerHarnessFactory(codexHarnessFactory);

export { localDispatch } from "./local-dispatch";
export type {
  ChatMessage,
  ChatMode,
  Harness,
  HarnessContext,
  HarnessFactory,
  HarnessId,
  HarnessProcessLocal,
  HarnessStreamInput,
  ModelSelection,
  ModelsConfig,
  ToolApprovalLevel,
} from "./types";
