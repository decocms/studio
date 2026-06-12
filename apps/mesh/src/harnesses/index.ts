import type { OrganizationScope, StudioContext } from "../core/studio-context";
import { claudeCodeHarnessFactory } from "@decocms/harness/claude-code/index";
import {
  decopilotHarnessFactory,
  registerClusterEnvironmentBuilder,
  registerDesktopEnvironmentBuilder,
} from "@decocms/harness/decopilot/index";
import { codexHarnessFactory } from "@decocms/harness/codex/index";
import { buildClusterEnvironmentTools } from "./decopilot/harness-deps";
import { buildDesktopEnvironmentTools } from "@decocms/harness/decopilot/desktop-runtime";
import { registerHarnessFactory } from "@decocms/harness/registry";

// Register the environment-deps builders for the unified decopilot factory.
// The factory (`./decopilot`) is environment-agnostic and looks these up at
// dispatch time; this barrel is the sole in-process registration point, so
// registering here guarantees both are present before any cluster/desktop
// dispatch. The cluster builder is `@/`-coupled (StudioContext) and the desktop
// builder reaches `@decocms/sandbox` — keeping the registration here (mesh) lets
// the factory itself stay portable.
registerClusterEnvironmentBuilder((args) => {
  const ctx = args.ctx as StudioContext;
  return buildClusterEnvironmentTools({
    ...args,
    ctx,
    organization: ctx.organization as OrganizationScope,
  });
});
registerDesktopEnvironmentBuilder(buildDesktopEnvironmentTools);

// Side-effect registration. Importing this module wires up the three
// in-tree harnesses. Out-of-tree harnesses register themselves the same way.
//
// CLI harnesses (claude-code, codex) are also imported by the desktop link
// daemon; decopilot pulls in cluster-only modules (RunRegistry, run-stream,
// mesh tools) and is only usable on the cluster side.
registerHarnessFactory(decopilotHarnessFactory);
registerHarnessFactory(claudeCodeHarnessFactory);
registerHarnessFactory(codexHarnessFactory);

// The import-isolated DESKTOP decopilot factory
// (`@decocms/harness/decopilot/desktop-factory`) is registered DIRECTLY in the
// daemon (packages/sandbox/daemon/entry.ts) — never through this cluster barrel,
// which only handles the in-process cluster dispatch path.

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
