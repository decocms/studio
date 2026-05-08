import { isSyntheticBranch } from "./constants";
import type { PackageManager, RuntimeName, TenantConfig } from "./types";

const VALID_RUNTIMES: ReadonlySet<RuntimeName> = new Set([
  "node",
  "bun",
  "deno",
]);
const VALID_PMS: ReadonlySet<PackageManager> = new Set([
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "deno",
]);
const BRANCH_RE = /^[A-Za-z0-9._/-]+$/;

export type ValidationError = { kind: "invalid"; reason: string };
export type ValidationOk = { kind: "ok" };
export type ValidationResult = ValidationOk | ValidationError;

/**
 * Validate a fully-merged TenantConfig (post-merge, pre-persist).
 *
 * All application fields are optional — partial configs are valid so callers
 * can patch one field at a time. We only validate field *values* when the
 * field is present. The orchestrator is responsible for gating "start" on a
 * sufficiently complete config.
 */
export function validateTenantConfig(config: TenantConfig): ValidationResult {
  if (config.git !== undefined) {
    const v = validateGit(config.git);
    if (v.kind === "invalid") return v;
  }
  if (config.application !== undefined) {
    const v = validateApplication(config.application);
    if (v.kind === "invalid") return v;
  }
  return { kind: "ok" };
}

function validateGit(git: NonNullable<TenantConfig["git"]>): ValidationResult {
  if (typeof git.repository?.cloneUrl !== "string") {
    return { kind: "invalid", reason: "git.repository.cloneUrl is required" };
  }
  if (git.repository.cloneUrl.length === 0) {
    return { kind: "invalid", reason: "git.repository.cloneUrl is empty" };
  }
  if (git.repository.branch !== undefined) {
    const b = git.repository.branch;
    // Synthetic branches (e.g. "thread:<id>", "ephemeral") are sandbox
    // isolation keys, not real git refs — skip format validation for them.
    if (
      !isSyntheticBranch(b) &&
      (typeof b !== "string" || !BRANCH_RE.test(b) || b.startsWith("-"))
    ) {
      return { kind: "invalid", reason: `git.repository.branch invalid: ${b}` };
    }
  }
  if (git.identity !== undefined) {
    if (
      typeof git.identity.userName !== "string" ||
      git.identity.userName.length === 0
    ) {
      return { kind: "invalid", reason: "git.identity.userName is required" };
    }
    if (
      typeof git.identity.userEmail !== "string" ||
      git.identity.userEmail.length === 0
    ) {
      return { kind: "invalid", reason: "git.identity.userEmail is required" };
    }
  }
  return { kind: "ok" };
}

function validateApplication(
  app: NonNullable<TenantConfig["application"]>,
): ValidationResult {
  if (app.runtime !== undefined && !VALID_RUNTIMES.has(app.runtime)) {
    return { kind: "invalid", reason: `runtime invalid: ${app.runtime}` };
  }
  if (app.packageManager !== undefined) {
    if (app.packageManager.name !== undefined) {
      if (typeof app.packageManager.name !== "string") {
        return {
          kind: "invalid",
          reason: "application.packageManager.name must be a string",
        };
      }
      if (!VALID_PMS.has(app.packageManager.name)) {
        return {
          kind: "invalid",
          reason: `packageManager invalid: ${app.packageManager.name}`,
        };
      }
    }
    if (
      app.packageManager.path !== undefined &&
      (typeof app.packageManager.path !== "string" ||
        app.packageManager.path.length === 0)
    ) {
      return {
        kind: "invalid",
        reason: "packageManager.path must be non-empty",
      };
    }
  }
  if (app.port !== undefined && !isValidPort(app.port)) {
    return {
      kind: "invalid",
      reason: `port invalid: ${app.port}`,
    };
  }
  return { kind: "ok" };
}

function isValidPort(p: unknown): p is number {
  return typeof p === "number" && Number.isInteger(p) && p > 0 && p <= 65535;
}
