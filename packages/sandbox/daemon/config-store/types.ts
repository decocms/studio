import type { PackageManagerConfig, RuntimeName, TenantConfig } from "../types";

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
