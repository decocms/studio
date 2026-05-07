import { existsSync, readdirSync } from "node:fs";
import type { Config } from "../types";
import { spawnSetupStep } from "./spawn-step";

export interface CloneDeps {
  config: Config;
  dropPrivileges?: boolean;
  onChunk: (source: "setup", data: string) => void;
}

/**
 * Returns true when `dir` exists, has files, but has no `.git` directory.
 * This happens when the daemon wrote `.decocms/daemon.json` into repoDir
 * before the first clone — git refuses to clone into a non-empty target, so
 * we need a different strategy (init + fetch) in that case.
 */
function isNonEmptyWithoutGit(dir: string): boolean {
  if (!existsSync(dir)) return false;
  try {
    const entries = readdirSync(dir);
    return entries.length > 0 && !entries.includes(".git");
  } catch {
    return false;
  }
}

function runStep(cmd: string, deps: CloneDeps): Promise<number> {
  deps.onChunk("setup", `$ ${cmd}\r\n`);
  return spawnSetupStep(cmd, deps.onChunk, deps.dropPrivileges);
}

const TRANSIENT_ERRORS = [
  "Could not resolve host",
  "early EOF",
  "unexpected disconnect",
  "Connection reset by peer",
  "Connection timed out",
];
const CLONE_MAX_RETRIES = 3;
const CLONE_RETRY_DELAY_MS = 3000;

function isTransient(output: string): boolean {
  return TRANSIENT_ERRORS.some((e) => output.includes(e));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runNetworkStep(cmd: string, deps: CloneDeps): Promise<number> {
  for (let attempt = 0; attempt <= CLONE_MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      deps.onChunk(
        "setup",
        `\r\n[clone] transient network error, retrying in ${CLONE_RETRY_DELAY_MS / 1000}s (attempt ${attempt + 1}/${CLONE_MAX_RETRIES + 1})...\r\n`,
      );
      await sleep(CLONE_RETRY_DELAY_MS);
    }
    let output = "";
    const tee: CloneDeps = {
      ...deps,
      onChunk: (src, data) => {
        output += data;
        deps.onChunk(src, data);
      },
    };
    const code = await runStep(cmd, tee);
    if (code === 0) return 0;
    if (!isTransient(output) || attempt >= CLONE_MAX_RETRIES) return code;
  }
  return 1;
}

/** Resolves to exit code (0 on success). Emits chunks via `onChunk`. */
export async function spawnClone(deps: CloneDeps): Promise<number> {
  const { config } = deps;
  const cloneUrl = config.git?.repository?.cloneUrl;
  if (!cloneUrl) {
    return 1;
  }
  if (!config.repoDir || !config.repoDir.startsWith("/")) {
    deps.onChunk(
      "setup",
      `\r\n[clone] repoDir is not an absolute path (got: ${String(config.repoDir)}) — aborting clone to prevent relative-path mishap\r\n`,
    );
    return 1;
  }

  const gc = `git -c safe.directory='*' -c credential.helper=`;
  const dir = config.repoDir;

  // When repoDir already has files (e.g. .decocms/daemon.json written before
  // the first clone) but no .git, `git clone` would fail with "already exists
  // and is not an empty directory". Use init+fetch+checkout instead — it
  // operates in-place and tolerates existing content.
  if (isNonEmptyWithoutGit(dir)) {
    const localSteps = [
      `${gc} -C ${dir} init`,
      `${gc} -C ${dir} remote add origin ${cloneUrl}`,
    ];
    for (const step of localSteps) {
      const code = await runStep(step, deps);
      if (code !== 0) return code;
    }
    const fetchCode = await runNetworkStep(
      `${gc} -C ${dir} fetch --depth 1 origin HEAD`,
      deps,
    );
    if (fetchCode !== 0) return fetchCode;
    return runStep(`${gc} -C ${dir} checkout FETCH_HEAD`, deps);
  }

  return runNetworkStep(`${gc} clone --depth 1 ${cloneUrl} ${dir}`, deps);
}
