import { existsSync, readdirSync } from "node:fs";
import { isSyntheticBranch } from "../constants";
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

// Git progress lines use bare \r (no \n) to overwrite the same terminal line.
// Log aggregators strip \r, collapsing all updates into one unreadable blob.
// Normalise \r → \r\n so each update becomes its own log line while still
// giving the user live progress feedback.
function normalizeCarriageReturns(data: string): string {
  return data.replace(/\r(?!\n)/g, "\r\n");
}

function runStep(cmd: string, deps: CloneDeps): Promise<number> {
  deps.onChunk("setup", `$ ${cmd}\r\n`);
  const normalized: CloneDeps = {
    ...deps,
    onChunk: (src, data) => deps.onChunk(src, normalizeCarriageReturns(data)),
  };
  return spawnSetupStep(cmd, normalized.onChunk, deps.dropPrivileges);
}

const TRANSIENT_ERRORS = [
  "Could not resolve host",
  "early EOF",
  "unexpected disconnect",
  "Connection reset by peer",
  "Connection timed out",
  // libcurl CURLE_OPERATION_TIMEDOUT triggered by http.lowSpeedLimit/Time —
  // fires when the egress NAT silently drops in-flight packets (e.g. fck-nat
  // ASG instance refresh) and the stream stalls below the threshold.
  "Operation too slow",
  "transfer closed with",
  "RPC failed",
  "the remote end hung up",
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

// `git ls-remote --exit-code` returns 2 when the remote was reachable but no
// matching ref was found. Any other non-zero exit is a real failure (auth,
// DNS, TLS, …) that we surface to the caller instead of silently falling
// through to a fork-from-default fallback.
const LS_REMOTE_NO_MATCH = 2;

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

  // GIT_TERMINAL_PROMPT=0 + GIT_ASKPASS=true: refuse to ever prompt for
  // credentials. Without this the PTY makes git think it has a terminal, so
  // a private repo without credentials hangs forever instead of failing fast.
  // Public repos clone fine — no prompt is needed in the first place.
  const gc = `GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=true git -c safe.directory='*' -c credential.helper= -c http.connectTimeout=10 -c http.lowSpeedLimit=1 -c http.lowSpeedTime=10`;
  const dir = config.repoDir;

  const requestedBranch = config.git?.repository?.branch;
  const branch =
    requestedBranch && !isSyntheticBranch(requestedBranch)
      ? requestedBranch
      : null;

  // Decide which branch to put the working tree on. `ls-remote --exit-code`
  // gives deterministic semantics that replace the old silent "try fetch,
  // fall through on any failure" probe:
  //   0   → branch exists on origin → clone it directly with --branch
  //   2   → origin reachable but branch absent → clone default, fork locally
  //   any → real failure → surface to caller
  let branchOnRemote: string | null = null;
  let branchToForkLocally: string | null = null;
  if (branch) {
    const probe = await runNetworkStep(
      `${gc} ls-remote --exit-code --heads ${cloneUrl} ${branch}`,
      deps,
    );
    if (probe === 0) {
      branchOnRemote = branch;
    } else if (probe === LS_REMOTE_NO_MATCH) {
      deps.onChunk(
        "setup",
        `[clone] branch '${branch}' not on remote; cloning default and forking locally\r\n`,
      );
      branchToForkLocally = branch;
    } else {
      deps.onChunk(
        "setup",
        `\r\n[clone] ls-remote failed (exit ${probe}); aborting clone\r\n`,
      );
      return probe;
    }
  }

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
    const fetchRef = branchOnRemote
      ? `+refs/heads/${branchOnRemote}:refs/remotes/origin/${branchOnRemote}`
      : "HEAD";
    const fetchCode = await runNetworkStep(
      `${gc} -C ${dir} fetch --depth 1 origin ${fetchRef}`,
      deps,
    );
    if (fetchCode !== 0) return fetchCode;
    const checkoutCmd = branchOnRemote
      ? `${gc} -C ${dir} checkout -B ${branchOnRemote} refs/remotes/origin/${branchOnRemote}`
      : `${gc} -C ${dir} checkout FETCH_HEAD`;
    const checkoutCode = await runStep(checkoutCmd, deps);
    if (checkoutCode !== 0) return checkoutCode;
    if (branchToForkLocally) {
      return runStep(
        `${gc} -C ${dir} checkout -B ${branchToForkLocally}`,
        deps,
      );
    }
    return 0;
  }

  const cloneCmd = branchOnRemote
    ? `${gc} clone --depth 1 --branch ${branchOnRemote} ${cloneUrl} ${dir}`
    : `${gc} clone --depth 1 ${cloneUrl} ${dir}`;
  const cloneCode = await runNetworkStep(cloneCmd, deps);
  if (cloneCode !== 0) return cloneCode;
  if (branchToForkLocally) {
    return runStep(`${gc} -C ${dir} checkout -B ${branchToForkLocally}`, deps);
  }
  return 0;
}
