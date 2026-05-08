import { IFRAME_BOOTSTRAP_SCRIPT } from "../shared";

export const MAX_SSE_CLIENTS = 10;
// Per-source ring buffer cap. Real install logs (clone + npm/bun install on a
// nontrivial repo) are easily 50–200 KB; with the prior 4 KB cap, late SSE
// joiners only saw the last few package-manager lines. 256 KB covers a
// typical setup pass while keeping worst-case memory bounded (~1 MB across
// the 3–4 sources in flight at once).
export const REPLAY_BYTES = 256 * 1024;
export const DECO_UID = 1000;
export const DECO_GID = 1000;
export const PROBE_FAST_MS = 1000;
export const PROBE_SLOW_MS = 30_000;
export const PROBE_HEAD_TIMEOUT_MS = 5_000;

/**
 * Synthetic branches are sandbox isolation keys, not real git refs.
 * They must be accepted by the daemon but never checked out.
 */
export function isSyntheticBranch(branch: string): boolean {
  return branch === "ephemeral" || branch.startsWith("thread:");
}

/** HTML injected before </body> so the preview iframe can talk to the parent. */
export const BOOTSTRAP_SCRIPT = IFRAME_BOOTSTRAP_SCRIPT;

/**
 * Inlined at bundle time so the runtime daemon stays self-contained —
 * no upward import to `apps/mesh` or `packages/sandbox/server`.
 */
// `manifest` files gate `install`: running `deno install` (and friends) on an
// empty workdir is at best a no-op and at worst a panic (Deno 2.2.6 crashes
// in deno_semver). When none of these exist in appRoot, install is skipped.
//
// `install` is optional: deno auto-fetches imports on first `deno task`, so
// there's no separate install step (and `deno install` without args means
// different things across Deno 1.x vs 2.x — both wrong here).
export const PACKAGE_MANAGER_DAEMON_CONFIG: Record<
  string,
  { install?: string; runPrefix: string; manifests: readonly string[] }
> = {
  npm: {
    install: "npm install",
    runPrefix: "npm run",
    manifests: ["package.json"],
  },
  pnpm: {
    install: "pnpm install",
    runPrefix: "pnpm run",
    manifests: ["package.json"],
  },
  yarn: {
    install: "yarn install",
    runPrefix: "yarn run",
    manifests: ["package.json"],
  },
  bun: {
    install: "bun install",
    runPrefix: "bun run",
    manifests: ["package.json"],
  },
  deno: {
    runPrefix: "deno task",
    manifests: ["deno.json", "deno.jsonc", "package.json"],
  },
};

export const WELL_KNOWN_STARTERS = ["dev", "start"] as const;

export function buildDevEnv(
  config: { application?: { port?: number } },
  overrides?: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {
    HOST: "0.0.0.0",
    HOSTNAME: "0.0.0.0",
    ...(overrides ?? {}),
  };
  const port = config.application?.port;
  if (port !== undefined && env.PORT === undefined) env.PORT = String(port);
  return env;
}

export function pmRunCommand(
  runtimePrefix: string,
  cwd: string,
  runPrefix: string,
  script: string,
): { cmd: string; label: string } {
  const cmd = `${runtimePrefix}cd ${cwd} && ${runPrefix} ${script}`;
  return {
    cmd,
    label: `$ ${cmd}`,
  };
}
