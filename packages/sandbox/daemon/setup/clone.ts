import { sleep } from "@decocms/std";
import { existsSync, readdirSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { isSyntheticBranch } from "../constants";
import { isValidRemoteBranchName } from "../git/ref-name";
import {
  formatCommand,
  type StructuredCommand,
} from "../process/structured-command";
import type { Config, SubmoduleCredential } from "../types";
import { gitBaseArgv, gitStepEnv } from "./git-command";
import { spawnSetupStep } from "./spawn-step";

export interface CloneDeps {
  config: Config;
  /** Absolute path of the materialized no-op askpass (see setup/askpass.ts). */
  askpassPath: string;
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

/** git <base flags> <extra…> as a StructuredCommand. */
function git(
  extra: readonly string[],
  askpassPath: string,
  opts: { cwd?: string } = {},
): StructuredCommand {
  return {
    argv: [...gitBaseArgv(), ...extra],
    env: gitStepEnv(askpassPath),
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
  };
}

/** Exported for unit tests — the exact clone argv for both branch cases. */
export function cloneCommand(p: {
  cloneUrl: string;
  dir: string;
  branchOnRemote: string | null;
  askpassPath: string;
}): StructuredCommand {
  const branchArgs = p.branchOnRemote ? ["--branch", p.branchOnRemote] : [];
  return git(
    ["clone", "--depth", "1", ...branchArgs, p.cloneUrl, p.dir],
    p.askpassPath,
  );
}

function runStep(cmd: StructuredCommand, deps: CloneDeps): Promise<number> {
  deps.onChunk("setup", `$ ${formatCommand(cmd)}\r\n`);
  const normalized: CloneDeps = {
    ...deps,
    onChunk: (src, data) => deps.onChunk(src, normalizeCarriageReturns(data)),
  };
  return spawnSetupStep(cmd, normalized.onChunk, {
    dropPrivileges: deps.dropPrivileges,
  });
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

async function runNetworkStep(
  cmd: StructuredCommand,
  deps: CloneDeps,
): Promise<number> {
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

/** Like runNetworkStep but also returns the (merged stdout+stderr) output. */
async function runNetworkStepCapture(
  cmd: StructuredCommand,
  deps: CloneDeps,
): Promise<{ code: number; output: string }> {
  let output = "";
  const tee: CloneDeps = {
    ...deps,
    onChunk: (src, data) => {
      output += data;
      deps.onChunk(src, data);
    },
  };
  const code = await runNetworkStep(cmd, tee);
  return { code, output };
}

/**
 * After a Case-2 clone (`--branch <branch>` for a branch that already exists on
 * origin), the shallow single-branch clone brings down only
 * `origin/<branch>` — `origin/<base>` is absent. `computeBranchDivergence`
 * then can't compute ahead/behind vs base and the header falsely reports
 * "Up to date" until a background fetch happens to populate the base ref.
 *
 * Fetch the remote's default branch (shallow, matching the Case-1 default
 * clone) and point `origin/HEAD` at it so divergence-vs-base is computable
 * from the moment the sandbox comes online. Best-effort: a failure here leaves
 * the working tree intact and only delays the base ref to the next fetch, so
 * we warn rather than abort the whole clone.
 *
 * The base is fetched at `--depth 1`, so `computeBranchDivergence`'s ahead/
 * behind counts are only exact when a merge-base is reachable within the
 * shallow slice; for a branch that diverged long ago the counts are
 * approximate. That's acceptable because the only consumer that matters —
 * the header button — reads `aheadOfBase > 0` as a boolean (the numeric
 * count and `behindBase` are not surfaced in the UI). A later full fetch
 * (e.g. the PR-diff path) corrects the numbers.
 */
async function fetchBaseBranch(
  askpassPath: string,
  dir: string,
  cloneUrl: string,
  branchOnRemote: string,
  deps: CloneDeps,
): Promise<void> {
  const { code, output } = await runNetworkStepCapture(
    git(["ls-remote", "--symref", cloneUrl, "HEAD"], askpassPath),
    deps,
  );
  if (code !== 0) {
    deps.onChunk(
      "setup",
      `\r\n[clone] warning: could not resolve remote default branch; divergence vs base unavailable until next fetch\r\n`,
    );
    return;
  }
  // "ref: refs/heads/main\tHEAD"
  const base = output.match(/ref:\s+refs\/heads\/(\S+)\s+HEAD/)?.[1] ?? null;
  if (!base || base === branchOnRemote) return;
  // `base` comes from remote-controlled ls-remote output and flows into a
  // `git fetch`/`symbolic-ref` argv below. The argv/env representation makes
  // shell injection impossible, but ref-format garbage (and flag-shaped
  // names) still has no business reaching git — shared allowlist, same as
  // the checkout path (git/ref-name.ts).
  if (!isValidRemoteBranchName(base)) {
    deps.onChunk(
      "setup",
      `\r\n[clone] warning: refusing unsafe base branch name ${JSON.stringify(base)}; divergence vs base unavailable until next fetch\r\n`,
    );
    return;
  }

  const fetchCode = await runNetworkStep(
    git(
      [
        "fetch",
        "--depth",
        "1",
        "origin",
        `+refs/heads/${base}:refs/remotes/origin/${base}`,
      ],
      askpassPath,
      { cwd: dir },
    ),
    deps,
  );
  if (fetchCode !== 0) {
    deps.onChunk(
      "setup",
      `\r\n[clone] warning: failed to fetch base branch '${base}'; divergence vs base unavailable until next fetch\r\n`,
    );
    return;
  }
  await runStep(
    git(
      [
        "symbolic-ref",
        "refs/remotes/origin/HEAD",
        `refs/remotes/origin/${base}`,
      ],
      askpassPath,
      { cwd: dir },
    ),
    deps,
  );
}

export interface CloneResult {
  /** Exit code — 0 on success. */
  code: number;
  /**
   * Deferred, best-effort fetch of the remote's default branch (+ the
   * origin/HEAD pointer) so `computeBranchDivergence` can report ahead/behind
   * vs base. Split off the clone critical path: it's 1-2 network round trips
   * (`ls-remote --symref` + `fetch`) that only feed the divergence header, so
   * the orchestrator runs it in the background once the working tree is ready
   * rather than blocking install+start behind it (the header just shows its
   * "unavailable until next fetch" state for a beat). Absent when no base
   * fetch is warranted (target branch absent on remote → local fork; or the
   * target IS the default branch). `onChunk` is injected by the caller because
   * the clone's own log tee is closed by the time this runs.
   */
  fetchBase?: (
    onChunk: (source: "setup", data: string) => void,
  ) => Promise<void>;
}

// A submodule host flows into a `git -c url.<…>.insteadOf` argv and into a
// git-credentials file line (`https://x-access-token:<token>@<host>`). Argv/
// file form makes shell injection impossible, but a host with a slash, `@`,
// whitespace, or control chars would corrupt the insteadOf prefix or the
// credential URL — so allow only a bare hostname with an optional port.
const VALID_SUBMODULE_HOST = /^[a-zA-Z0-9.-]+(?::[0-9]+)?$/;

/**
 * Exported for unit tests. Validates + dedupes submodule credentials by host
 * (last write wins), returning the git-credential-store file lines for the
 * valid hosts plus the rejected hosts. Deterministic: no fs/network.
 */
export function prepareSubmoduleCredentials(
  credentials: readonly SubmoduleCredential[],
): { lines: string[]; hosts: string[]; invalidHosts: string[] } {
  const invalidHosts: string[] = [];
  const tokenByHost = new Map<string, string>();
  for (const c of credentials) {
    if (!VALID_SUBMODULE_HOST.test(c.host)) {
      invalidHosts.push(c.host);
      continue;
    }
    tokenByHost.set(c.host, c.token);
  }
  const hosts = [...tokenByHost.keys()];
  const lines = [...tokenByHost].map(
    ([host, token]) =>
      `https://x-access-token:${encodeURIComponent(token)}@${host}`,
  );
  return { lines, hosts, invalidHosts };
}

/**
 * Exported for unit tests. The exact `git` extra-args for a submodule update:
 * per-host SSH→HTTPS `insteadOf` rewrites (no token) followed by the
 * store-helper pointer and the shallow recursive `submodule update`. Combined
 * with `gitBaseArgv()`'s leading `-c credential.helper=` (which resets the
 * helper list), the store helper is the only one in effect for this command
 * and its submodule subprocesses (they inherit `-c` via GIT_CONFIG_PARAMETERS).
 */
export function submoduleUpdateArgs(p: {
  hosts: readonly string[];
  credFile: string;
}): string[] {
  const rewriteArgs = p.hosts.flatMap((host) => [
    "-c",
    `url.https://${host}/.insteadOf=git@${host}:`,
    "-c",
    `url.https://${host}/.insteadOf=ssh://git@${host}/`,
  ]);
  return [
    ...rewriteArgs,
    "-c",
    `credential.helper=store --file=${p.credFile}`,
    "submodule",
    "update",
    "--init",
    "--recursive",
    "--depth",
    "1",
  ];
}

/**
 * Fetch git submodules after the working tree is materialized, authenticating
 * private submodules with user-supplied per-host PATs. Best-effort: a failure
 * warns and leaves the (bare) working tree intact rather than failing the whole
 * clone, mirroring `fetchBaseBranch`.
 *
 * Credentials are delivered on a git-only channel — never the env bag the dev
 * server sees. The token lives only in a short-lived credentials file (mode
 * 0o600, next to the no-op askpass, outside the repo) read by
 * `git-credential-store` for the submodule fetch, then deleted. `insteadOf`
 * rewrites (which carry NO token) turn `git@<host>:` / `ssh://git@<host>/`
 * submodule URLs into HTTPS so the store credential applies; the token is never
 * placed in argv and never persisted into the repo's `.git/config`.
 *
 * No-op when no credentials are configured (feature is opt-in) or the repo
 * declares no submodules.
 */
async function runSubmoduleUpdate(p: {
  deps: CloneDeps;
  dir: string;
  askpassPath: string;
  credentials: readonly SubmoduleCredential[] | undefined;
}): Promise<void> {
  const { deps, dir, askpassPath, credentials } = p;
  if (!credentials || credentials.length === 0) return;
  if (!existsSync(join(dir, ".gitmodules"))) return;

  const { lines, hosts, invalidHosts } =
    prepareSubmoduleCredentials(credentials);
  for (const host of invalidHosts) {
    deps.onChunk(
      "setup",
      `\r\n[clone] warning: skipping submodule credential with invalid host ${JSON.stringify(host)}\r\n`,
    );
  }
  if (hosts.length === 0) return;

  const credFile = join(dirname(askpassPath), "submodule-git-credentials");
  await writeFile(credFile, `${lines.join("\n")}\n`, { mode: 0o600 });

  try {
    const cmd = git(submoduleUpdateArgs({ hosts, credFile }), askpassPath, {
      cwd: dir,
    });
    const code = await runNetworkStep(cmd, deps);
    if (code !== 0) {
      deps.onChunk(
        "setup",
        `\r\n[clone] warning: submodule update failed (exit ${code}); continuing without submodules\r\n`,
      );
    }
  } finally {
    await rm(credFile, { force: true });
  }
}

/**
 * Acquires the repo working tree (0 on success). Emits progress via `onChunk`.
 * The returned `fetchBase` thunk (when present) does the off-critical-path
 * base-branch fetch — see CloneResult.
 */
export async function spawnClone(deps: CloneDeps): Promise<CloneResult> {
  const { config, askpassPath } = deps;
  const cloneUrl = config.git?.repository?.cloneUrl;
  if (!cloneUrl) {
    return { code: 1 };
  }
  if (!config.repoDir || !isAbsolute(config.repoDir)) {
    deps.onChunk(
      "setup",
      `\r\n[clone] repoDir is not an absolute path (got: ${String(config.repoDir)}) — aborting clone to prevent relative-path mishap\r\n`,
    );
    return { code: 1 };
  }

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
    // `branch` is config-supplied and flows into git argv below
    // (ls-remote/clone/checkout). Argv can't be shell-injected, but a
    // flag-shaped or ref-format-invalid name still has no business reaching
    // git — same shared allowlist as the `base` check above and the
    // checkout path (git/ref-name.ts).
    if (!isValidRemoteBranchName(branch)) {
      deps.onChunk(
        "setup",
        `\r\n[clone] refusing invalid branch name ${JSON.stringify(branch)}\r\n`,
      );
      return { code: 1 };
    }
    const probe = await runNetworkStep(
      git(
        ["ls-remote", "--exit-code", "--heads", cloneUrl, branch],
        askpassPath,
      ),
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
      return { code: probe };
    }
  }

  // Built once branchOnRemote is known; both acquisition paths return it so
  // the orchestrator can run the base fetch after the dev server is up.
  const deferBaseFetch =
    (branchOnRemoteForFetch: string) =>
    (onChunk: (source: "setup", data: string) => void) =>
      fetchBaseBranch(askpassPath, dir, cloneUrl, branchOnRemoteForFetch, {
        ...deps,
        onChunk,
      });

  // Funnels every success return through the (best-effort, opt-in) submodule
  // fetch so both acquisition paths and both branch cases get submodules.
  const finalize = async (
    code: number,
    extra: Omit<CloneResult, "code"> = {},
  ): Promise<CloneResult> => {
    if (code === 0) {
      await runSubmoduleUpdate({
        deps,
        dir,
        askpassPath,
        credentials: config.git?.repository?.submoduleCredentials,
      });
    }
    return { code, ...extra };
  };

  // When repoDir already has files (e.g. .decocms/daemon.json written before
  // the first clone) but no .git, `git clone` would fail with "already exists
  // and is not an empty directory". Use init+fetch+checkout instead — it
  // operates in-place and tolerates existing content.
  if (isNonEmptyWithoutGit(dir)) {
    const localSteps = [
      git(["init"], askpassPath, { cwd: dir }),
      git(["remote", "add", "origin", cloneUrl], askpassPath, { cwd: dir }),
    ];
    for (const step of localSteps) {
      const code = await runStep(step, deps);
      if (code !== 0) return { code };
    }
    // When no branch was requested (and none needs forking locally), `git
    // clone` would land on the remote's default branch as a real local
    // branch. Mirror that here by resolving the default branch name first —
    // otherwise `checkout FETCH_HEAD` below leaves the working tree in
    // detached HEAD, unlike the normal clone path (see clone.test.ts).
    let defaultBranch: string | null = null;
    if (!branchOnRemote && !branchToForkLocally) {
      const { code: symrefCode, output } = await runNetworkStepCapture(
        git(["ls-remote", "--symref", cloneUrl, "HEAD"], askpassPath),
        deps,
      );
      const resolved =
        symrefCode === 0
          ? (output.match(/ref:\s+refs\/heads\/(\S+)\s+HEAD/)?.[1] ?? null)
          : null;
      if (resolved && isValidRemoteBranchName(resolved))
        defaultBranch = resolved;
    }
    const branchToTrack = branchOnRemote ?? defaultBranch;
    const fetchRef = branchToTrack
      ? `+refs/heads/${branchToTrack}:refs/remotes/origin/${branchToTrack}`
      : "HEAD";
    const fetchCode = await runNetworkStep(
      git(["fetch", "--depth", "1", "origin", fetchRef], askpassPath, {
        cwd: dir,
      }),
      deps,
    );
    if (fetchCode !== 0) return { code: fetchCode };
    // `-f`: the daemon writes files into repoDir before the first clone (that's
    // why we're on the init+fetch path), and the CMS can leave stale untracked
    // `.deco/blocks/*.json` there. Those collide with branch-tracked paths and
    // a plain checkout aborts ("untracked working tree files would be
    // overwritten"). Force lets the committed branch content win; only files
    // that collide with tracked paths are overwritten — `.decocms/daemon.json`
    // (not tracked on the branch) is left in place.
    const checkoutCmd = branchToTrack
      ? git(
          [
            "checkout",
            "-f",
            "-B",
            branchToTrack,
            `refs/remotes/origin/${branchToTrack}`,
          ],
          askpassPath,
          { cwd: dir },
        )
      : git(["checkout", "-f", "FETCH_HEAD"], askpassPath, { cwd: dir });
    const checkoutCode = await runStep(checkoutCmd, deps);
    if (checkoutCode !== 0) return { code: checkoutCode };
    if (branchToForkLocally) {
      return finalize(
        await runStep(
          git(["checkout", "-B", branchToForkLocally], askpassPath, {
            cwd: dir,
          }),
          deps,
        ),
      );
    }
    return finalize(
      0,
      branchToTrack ? { fetchBase: deferBaseFetch(branchToTrack) } : {},
    );
  }

  const cloneCmd = cloneCommand({ cloneUrl, dir, branchOnRemote, askpassPath });
  const cloneCode = await runNetworkStep(cloneCmd, deps);
  if (cloneCode !== 0) return { code: cloneCode };
  if (branchToForkLocally) {
    return finalize(
      await runStep(
        git(["checkout", "-B", branchToForkLocally], askpassPath, { cwd: dir }),
        deps,
      ),
    );
  }
  return finalize(
    0,
    branchOnRemote ? { fetchBase: deferBaseFetch(branchOnRemote) } : {},
  );
}
