import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TenantConfig } from "./types";

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
 * the mesh didn't supply (package manager, runtime, port). The daemon
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
  return { kind: "valid", config: parsed as TenantConfig };
}
