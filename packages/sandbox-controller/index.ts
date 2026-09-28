import { KubeConfig } from "@kubernetes/client-node";

export {
  AgentSandboxProvider,
  parseTenantPools,
  type ClaimPhase,
} from "@decocms/sandbox/provider/agent-sandbox";
export type {
  EnsureOptions,
  RunnerStatePut,
  RunnerStateRecord,
  RunnerStateRecordWithId,
  RunnerStateStore,
  RunnerStateStoreOps,
  Sandbox,
  SandboxId,
} from "@decocms/sandbox/provider";
export * from "@decocms/sandbox/provider/sandbox-api";
export * from "@decocms/sandbox/provider/sandbox-server";

/**
 * A kubeconfig for `AgentSandboxProvider`, built with this package's own
 * client so a host on another client version can still pass one.
 */
export function loadKubeConfig(opts: {
  path: string;
  context?: string;
}): KubeConfig {
  const kc = new KubeConfig();
  kc.loadFromFile(opts.path);
  if (opts.context) kc.setCurrentContext(opts.context);
  return kc;
}
