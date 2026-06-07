import { claudeCodeHarnessFactory } from "./claude-code";
import { codexHarnessFactory } from "./codex";
import { decopilotHarnessFactory } from "./decopilot";
import { decopilotDesktopHarnessFactory } from "./decopilot-desktop";
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

// The import-isolated desktop decopilot factory lives in `decopilot-desktop/`
// and is registered DIRECTLY in the daemon (packages/sandbox/daemon/entry.ts)
// via a relative subpath import — never through this cluster barrel, because
// pulling the barrel would drag the cluster `decopilotHarnessFactory` tree into
// the daemon bundle. It is intentionally NOT registered in-process here (it has
// the same "decopilot" id as the cluster factory and only runs inside the
// daemon). Referencing it keeps the cluster module graph aware of the file so
// it isn't seen as dead — the same reason the CLI factories above are imported
// even though the daemon imports them by subpath too.
void decopilotDesktopHarnessFactory;

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
