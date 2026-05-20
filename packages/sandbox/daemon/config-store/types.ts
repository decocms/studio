import type { PackageManagerConfig, RuntimeName, TenantConfig } from "../types";

/**
 * Patch shape accepted by the store. Same as `Partial<TenantConfig>` except
 * `env` may carry `null` per key to signal deletion — merge resolves those
 * before classification, so the post-merge `TenantConfig` never contains nulls.
 */
export type ConfigPatch = Partial<Omit<TenantConfig, "env">> & {
  env?: Record<string, string | null>;
};

/**
 * The single highest-impact transition produced by classifying (before, after).
 * Reducer recipes live in setup/orchestrator.ts.
 */
export type Transition =
  | { kind: "bootstrap"; config: TenantConfig }
  | { kind: "branch-change"; from: string | undefined; to: string }
  | {
      kind: "pm-change";
      from: PackageManagerConfig | undefined;
      to: PackageManagerConfig;
    }
  | { kind: "runtime-change"; from: RuntimeName | undefined; to: RuntimeName }
  | {
      kind: "port-change";
      from: number | undefined;
      to: number | undefined;
    }
  | {
      kind: "env-change";
      /** Key names only — values never leak through transitions. */
      changed: { set: string[]; deleted: string[] };
    }
  | { kind: "identity-conflict"; field: "cloneUrl" }
  | { kind: "no-op" };

export interface ApplyEvent {
  before: TenantConfig | null;
  after: TenantConfig;
  transition: Transition;
}

export const REJECTION_REASONS = {
  INVALID: "invalid",
  IMMUTABLE: "immutable",
  APPLY_FAILED: "apply failed",
} as const;

export type RejectionReason =
  (typeof REJECTION_REASONS)[keyof typeof REJECTION_REASONS];

export type ApplyResult =
  | {
      kind: "applied";
      before: TenantConfig | null;
      after: TenantConfig;
      transition: Transition;
    }
  | { kind: "rejected"; reason: RejectionReason; detail?: string };
