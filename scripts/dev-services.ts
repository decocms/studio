#!/usr/bin/env bun
/**
 * Re-exports service management from apps/mesh/src/services/ensure-services.ts.
 * This file exists so scripts/dev-services-cli.ts and scripts/dev.ts can import
 * without reaching into apps/mesh/src/ directly.
 */
export {
  ensureServices,
  stopServices,
  serviceStatus,
  getStatus,
  printTable,
} from "../apps/mesh/src/services/ensure-services.ts";
export type { ServiceInfo } from "../apps/mesh/src/services/ensure-services.ts";
