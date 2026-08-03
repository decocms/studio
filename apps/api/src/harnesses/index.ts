import type { OrganizationScope, StudioContext } from "../core/studio-context";
import { registerClusterEnvironmentBuilder } from "@/harnesses/lib/decopilot/index";
import { buildClusterEnvironmentTools } from "./decopilot/harness-deps";

// Register the environment-deps builder for the decopilot factory. This
// side-effect is why dispatch paths import this barrel before dispatching:
// the factory's stream() throws if no cluster environment builder is set.
//
// Decopilot is the only harness the cluster hosts — dispatch is hard-wired to
// its factory in `in-process-sandbox-client.ts` (the one-entry registry this
// barrel used to populate is gone). The CLI harnesses (claude-code, codex) are
// rejected by `assertHarnessRunsInCluster` at the gate and again by
// `dispatchRunAndWait`; local CLI runs happen in the Tauri desktop app
// (`apps/native`, its own Rust harness crate), and cloud-CLI is unimplemented.
registerClusterEnvironmentBuilder((args) => {
  const ctx = args.ctx as StudioContext;
  return buildClusterEnvironmentTools({
    ...args,
    ctx,
    organization: ctx.organization as OrganizationScope,
  });
});

export { createSecretModelSource } from "@/harnesses/lib/types";
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
} from "@/harnesses/lib/types";
