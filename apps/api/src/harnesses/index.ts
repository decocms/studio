import type { OrganizationScope, StudioContext } from "../core/studio-context";
import {
  registerClusterEnvironmentBuilder,
  streamDecopilot,
} from "@/harnesses/lib/decopilot/index";
import { buildClusterEnvironmentTools } from "./decopilot/harness-deps";

// Register the environment-deps builder for the Decopilot stream. This
// side-effect is why dispatch paths import this barrel before dispatching:
// streamDecopilot() throws if no cluster environment builder is set.
//
// Decopilot is the only hosted runtime. Local CLI runs happen in the Tauri
// desktop app (`apps/native`, its own Rust harness crate).
registerClusterEnvironmentBuilder((args) => {
  const ctx = args.ctx as StudioContext;
  return buildClusterEnvironmentTools({
    ...args,
    ctx,
    organization: ctx.organization as OrganizationScope,
  });
});

export { streamDecopilot };
export { createSecretModelSource } from "@/harnesses/lib/types";
export type {
  ChatMessage,
  ChatMode,
  DecopilotSecretModelSource,
  DecopilotSecretModelSources,
  DecopilotStreamInput,
  HarnessContext,
  HarnessUserContext,
  ModelSelection,
  ModelsConfig,
  ToolApprovalLevel,
} from "@/harnesses/lib/types";
