/**
 * @decocms/harness — public barrel (the `.` export).
 *
 * Re-exports the portable harness surface shared across the monorepo (studio +
 * the sandbox daemon). The subpath entries (./types, ./registry, ./claude-code,
 * ./codex, ./decopilot, ./sources) expose those modules directly; this barrel
 * aggregates the commonly-imported symbols plus a few deep leaves the 7-entry
 * exports map does not surface on their own.
 */
export * from "./types";
export {
  getHarnessFactory,
  registerHarnessFactory,
  resetRegistryForTests,
} from "./registry";
