import type { OrganizationScope, StudioContext } from "../core/studio-context";
import { claudeCodeHarnessFactory } from "./claude-code";
import {
  decopilotHarnessFactory,
  registerClusterEnvironmentBuilder,
  registerDesktopEnvironmentBuilder,
} from "./decopilot";
import { codexHarnessFactory } from "./codex";
import { decopilotDesktopHarnessFactory } from "./decopilot/desktop-factory";
import { buildClusterEnvironmentTools } from "./decopilot/harness-deps";
import { buildDesktopEnvironmentTools } from "./decopilot/desktop-runtime";
import { registerHarnessFactory } from "./registry";

// Register the environment-deps builders for the unified decopilot factory.
// The factory (`./decopilot`) is environment-agnostic and looks these up at
// dispatch time; this barrel is the sole in-process registration point, so
// registering here guarantees both are present before any cluster/desktop
// dispatch. The cluster builder is `@/`-coupled (StudioContext) and the desktop
// builder reaches `@decocms/sandbox` — keeping the registration here (mesh) lets
// the factory itself stay portable.
registerClusterEnvironmentBuilder((args) =>
  buildClusterEnvironmentTools({
    ...args,
    ctx: args.ctx as StudioContext,
    organization: args.organization as OrganizationScope,
  }),
);
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
// (`./decopilot/desktop-factory.ts`) is registered DIRECTLY in the daemon
// (packages/sandbox/daemon/entry.ts) via a relative subpath import — never
// through this cluster barrel, because pulling the barrel would drag the
// cluster `decopilotHarnessFactory` tree into the daemon bundle. It shares the
// "decopilot" id with the cluster factory and only runs inside the daemon, so
// it is intentionally NOT registered in-process here. Referencing it keeps the
// cluster module graph aware of the file so it isn't seen as dead — the same
// reason the CLI factories above are imported even though the daemon imports
// them by subpath too.
void decopilotDesktopHarnessFactory;

export { localDispatch } from "./local-dispatch";
export { createSecretModelSource } from "./types";
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
} from "./types";
