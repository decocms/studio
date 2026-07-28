import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TenantConfig } from "./types";
import { validateTenantConfig } from "./validate";

const DECOCMS_SUBDIR = ".decocms";
const DAEMON_JSON = "daemon.json";
const CONFIG_FILENAME = join(DECOCMS_SUBDIR, DAEMON_JSON);

function configPath(repoDir: string): string {
  return join(repoDir, CONFIG_FILENAME);
}

export type ReadOutcome =
  | { kind: "absent" }
  | { kind: "valid"; config: TenantConfig }
  | { kind: "invalid"; reason: string };

/**
 * Reads `<repoDir>/.decocms/daemon.json` as a read-only fallback for fields
 * the studio didn't supply (package manager, runtime, port). The daemon
 * never writes this file; it exists only if a tenant committed one to the
 * repo themselves.
 */
export function readConfig(repoDir: string): ReadOutcome {
  let raw: string;
  try {
    raw = readFileSync(configPath(repoDir), "utf-8");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return { kind: "absent" };
    return { kind: "invalid", reason: `read failed: ${err.message}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return {
      kind: "invalid",
      reason: `parse failed: ${(e as Error).message}`,
    };
  }

  if (!parsed || typeof parsed !== "object") {
    return { kind: "invalid", reason: "not an object" };
  }
  const config = parsed as TenantConfig;
  // This file is tenant-committed, not gated by the daemon-token auth that
  // protects PUT /config — it must clear the same validation (port range,
  // package-manager allowlist, env key/size limits, branch format, ...)
  // before anything trusts it, or a bad committed file could feed
  // unvalidated values straight into subprocess spawning.
  const validation = validateTenantConfig(config);
  if (validation.kind === "invalid") {
    return { kind: "invalid", reason: validation.reason };
  }
  return { kind: "valid", config };
}
