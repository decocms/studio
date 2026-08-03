import type { OrganizationScope, StudioContext } from "../core/studio-context";
import {
  decopilotHarnessFactory,
  registerClusterEnvironmentBuilder,
} from "@decocms/harness/decopilot/index";
import { buildClusterEnvironmentTools } from "./decopilot/harness-deps";
import { registerHarnessFactory } from "@decocms/harness/registry";

// Register the environment-deps builders for the unified decopilot factory.
// This barrel is the sole in-process registration point for cluster Decopilot
// dispatch.
registerClusterEnvironmentBuilder((args) => {
  const ctx = args.ctx as StudioContext;
  return buildClusterEnvironmentTools({
    ...args,
    ctx,
    organization: ctx.organization as OrganizationScope,
  });
});

// Side-effect registration. Importing this module wires up the ONLY harness
// the cluster can host. Out-of-tree harnesses register themselves the same way.
//
// Decopilot only, deliberately: the CLI harnesses (claude-code, codex) are
// rejected before any factory lookup — `assertHarnessRunsInCluster`
// (dispatch-queue/thread-gate-workflow.ts) throws at the gate, and
// `dispatchRunAndWait` throws again on a non-decopilot id. Registering them
// here could only ever produce a factory nobody can reach. Local CLI runs
// happen in the Tauri desktop app (`apps/native`, its own Rust harness crate);
// cloud-CLI is unimplemented. Wiring a CLI harness into the cluster means
// giving it a real host in those two guards first — this registration was
// never what was missing.
registerHarnessFactory(decopilotHarnessFactory);

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
