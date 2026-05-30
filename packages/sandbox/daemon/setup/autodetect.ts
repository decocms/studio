import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Application, PackageManager, RuntimeName } from "../types";

interface Detection {
  packageManager: PackageManager;
  runtime: RuntimeName;
}

const RULES: ReadonlyArray<{ file: string; detection: Detection }> = [
  { file: "deno.json", detection: { packageManager: "deno", runtime: "deno" } },
  {
    file: "deno.jsonc",
    detection: { packageManager: "deno", runtime: "deno" },
  },
  { file: "bun.lock", detection: { packageManager: "bun", runtime: "bun" } },
  { file: "bun.lockb", detection: { packageManager: "bun", runtime: "bun" } },
  {
    file: "pnpm-lock.yaml",
    detection: { packageManager: "pnpm", runtime: "node" },
  },
  {
    file: "yarn.lock",
    detection: { packageManager: "yarn", runtime: "node" },
  },
];

const NPM_FALLBACK: Detection = { packageManager: "npm", runtime: "node" };

/**
 * Best-effort runtime/pm guess from lockfile presence at the repo root.
 * Falls back to npm/node when no lockfile is recognised. Returns only the
 * fields that aren't already populated on the existing application config.
 */
export function autodetectApplication(
  repoDir: string,
  existing: Application | undefined,
): Partial<Application> {
  if (existing?.packageManager?.name && existing?.runtime) return {};

  const detected = detect(repoDir);
  return {
    ...(existing?.packageManager?.name
      ? {}
      : { packageManager: { name: detected.packageManager } }),
    ...(existing?.runtime ? {} : { runtime: detected.runtime }),
  };
}

function detect(repoDir: string): Detection {
  for (const rule of RULES) {
    if (existsSync(join(repoDir, rule.file))) return rule.detection;
  }
  return NPM_FALLBACK;
}
