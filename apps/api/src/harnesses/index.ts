import type { OrganizationScope, StudioContext } from "../core/studio-context";
import { claudeCodeHarnessFactory } from "@decocms/harness/claude-code/index";
import {
  decopilotHarnessFactory,
  registerClusterEnvironmentBuilder,
} from "@decocms/harness/decopilot/index";
import { codexHarnessFactory } from "@decocms/harness/codex/index";
import { buildClusterEnvironmentTools } from "./decopilot/harness-deps";
import { registerHarnessFactory } from "@decocms/harness/registry";

// Register the environment-deps builders for the unified decopilot factory.
// This barrel is the sole in-process registration point for cluster Decopilot
// dispatch. Desktop Decopilot is intentionally not registered; user-desktop
// execution is reserved for CLI harnesses.
registerClusterEnvironmentBuilder((args) => {
  const ctx = args.ctx as StudioContext;
  return buildClusterEnvironmentTools({
    ...args,
    ctx,
    organization: ctx.organization as OrganizationScope,
  });
});

// Side-effect registration. Importing this module wires up the three
// in-tree harnesses. Out-of-tree harnesses register themselves the same way.
//
// CLI harnesses (claude-code, codex) are also imported by the desktop link
// daemon; decopilot pulls in cluster-only modules (RunRegistry, run-stream,
// studio tools) and is only usable on the cluster side.
registerHarnessFactory(decopilotHarnessFactory);
registerHarnessFactory(claudeCodeHarnessFactory);
registerHarnessFactory(codexHarnessFactory);

export { localDispatch } from "./local-dispatch";
export { createSecretModelSource } from "@decocms/harness/types";
export type {
  ChatMessage,
  ChatMode,
  DecopilotSecretModelSource,
  DecopilotSecretModelSources,
  Harness,
  HarnessContext,
  HarnessFactory,
  HarnessId,
  HarnessStreamInput,
  HarnessUserContext,
  ModelSelection,
  ModelsConfig,
  ToolApprovalLevel,
} from "@decocms/harness/types";
