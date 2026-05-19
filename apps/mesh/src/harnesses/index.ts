import { claudeCodeHarnessFactory } from "./claude-code";
import { codexHarnessFactory } from "./codex";
import { decopilotHarnessFactory } from "./decopilot";
import { registerHarnessFactory } from "./registry";

// Side-effect registration. Importing this module wires up the three
// in-tree harnesses. Out-of-tree harnesses register themselves the same way.
registerHarnessFactory(decopilotHarnessFactory);
registerHarnessFactory(claudeCodeHarnessFactory);
registerHarnessFactory(codexHarnessFactory);

export { localDispatch } from "./local-dispatch";
export type {
  Harness,
  HarnessFactory,
  HarnessId,
  HarnessStreamInput,
} from "./types";
