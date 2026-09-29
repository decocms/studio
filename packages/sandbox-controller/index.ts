import { KubeConfig } from "@kubernetes/client-node";

export {
  AgentSandboxProvider,
  parseTenantPools,
  tenantPoolSchema,
  type ClaimPhase,
  type PortForwarder,
  type TenantPool,
} from "@decocms/sandbox/provider/agent-sandbox";
export {
  migrateSandboxControllerSchema,
  postgresRunnerStateStore,
  postgresTenantPoolStore,
  storedTenantPoolInputSchema,
  TenantPoolConflictError,
  tenantPoolReader,
  type PostgresRunnerStateStore,
  type PostgresRunnerStateStoreOptions,
  type PostgresTenantPoolStore,
  type PostgresTenantPoolStoreOptions,
  type StoredTenantPool,
  type StoredTenantPoolInput,
  type TenantPoolReader,
  type TenantPoolReaderOptions,
  type TenantPoolStore,
} from "@decocms/sandbox/provider/postgres-state-store";
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
 * A kubeconfig for `AgentSandboxProvider` pointing at `server` with no
 * credentials: a local proxy that authenticates on the host's behalf. Built
 * with this package's own client, whatever client version the host runs.
 */
export function kubeConfigForServer(server: string): KubeConfig {
  const kc = new KubeConfig();
  kc.loadFromOptions({
    // The client refuses plain http unless this is set; a loopback http
    // proxy has no TLS to verify.
    clusters: [{ name: "sandbox", server, skipTLSVerify: true }],
    users: [{ name: "sandbox" }],
    contexts: [{ name: "sandbox", cluster: "sandbox", user: "sandbox" }],
    currentContext: "sandbox",
  });
  return kc;
}
