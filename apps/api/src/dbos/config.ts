import type { DBOSConfig } from "@dbos-inc/dbos-sdk";
import { DBOS_WORKFLOW_VERSION } from "./workflow-version";

export interface BuildDbosConfigInput {
  /** Already passed through withSslmode() by the caller. */
  systemDatabaseUrl: string;
  poolSize: number;
  executorID: string | undefined;
  /** Pod-role queue filter; omit/undefined => the "all" role (listen to every queue). */
  listenQueues?: string[];
}

/**
 * Builds the DBOS.setConfig() argument. Pure + side-effect-free so the
 * applicationVersion wiring is unit-testable (index.ts is not). The ONLY
 * difference from the historical inline object is the pinned applicationVersion.
 */
export function buildDbosConfig(input: BuildDbosConfigInput): DBOSConfig {
  return {
    name: "decocms",
    systemDatabaseUrl: input.systemDatabaseUrl,
    systemDatabaseSchemaName: "dbos",
    systemDatabasePoolSize: input.poolSize,
    runAdminServer: false,
    executorID: input.executorID,
    // Pin recovery compatibility so deploys don't strand in-flight workflows.
    applicationVersion: DBOS_WORKFLOW_VERSION,
    ...(input.listenQueues !== undefined
      ? { listenQueues: input.listenQueues }
      : {}),
  };
}
