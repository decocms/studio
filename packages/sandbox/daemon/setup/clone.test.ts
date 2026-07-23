import { describe, expect, it, test } from "bun:test";
import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeBranchDivergence } from "../git/branch-divergence";
import type { Config } from "../types";
import {
  cloneCommand,
  prepareSubmoduleCredentials,
  spawnClone,
  submoduleUpdateArgs,
} from "./clone";

const ASKPASS = "/data/askpass.sh";

/**
 * Creates a bare "origin" git repo with two branches:
 *   - main      → contains README.md
 *   - feature/x → contains README.md + feature.txt (branched from main+1)
 *
 * Returned `url` is a `file://` URL safe to use as a clone source.
 */
function setupBareRepo(): {
  url: string;
  root: string;
  bare: string;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "clonetest-"));
  const bare = join(root, "origin.git");
  const seed = join(root, "seed");
  const gitOpts = { stdio: "ignore" as const };
  const gitcfg = `-c init.defaultBranch=main -c user.email=test@example.com -c user.name=test -c commit.gpgsign=false`;
  execSync(`git ${gitcfg} init --bare ${bare}`, gitOpts);
  execSync(`git ${gitcfg} init ${seed}`, gitOpts);
  writeFileSync(join(seed, "README.md"), "hello\n");
  execSync(`git ${gitcfg} -C ${seed} add .`, gitOpts);
  execSync(`git ${gitcfg} -C ${seed} commit -m initial`, gitOpts);
  execSync(`git ${gitcfg} -C ${seed} branch -M main`, gitOpts);
  execSync(`git ${gitcfg} -C ${seed} remote add origin ${bare}`, gitOpts);
  execSync(`git ${gitcfg} -C ${seed} push -u origin main`, gitOpts);
  execSync(`git ${gitcfg} -C ${seed} checkout -b feature/x`, gitOpts);
  writeFileSync(join(seed, "feature.txt"), "feature\n");
  execSync(`git ${gitcfg} -C ${seed} add .`, gitOpts);
  execSync(`git ${gitcfg} -C ${seed} commit -m feature`, gitOpts);
  execSync(`git ${gitcfg} -C ${seed} push origin feature/x`, gitOpts);
  // Make `main` the default branch the bare repo's HEAD points at, so a clone
  // without --branch lands on main.
  execSync(
    `git ${gitcfg} -C ${bare} symbolic-ref HEAD refs/heads/main`,
    gitOpts,
  );
  return {
    url: `file://${bare}`,
    root,
    bare,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function currentBranch(repoDir: string): string {
  return execSync(`git -C ${repoDir} rev-parse --abbrev-ref HEAD`)
    .toString()
    .trim();
}

/** Run a git command, returning trimmed stdout or null on non-zero exit. */
function tryGitOut(repoDir: string, args: string): string | null {
  try {
    return execSync(`git -C ${repoDir} ${args}`, {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

function makeConfig(
  repoDir: string,
  cloneUrl: string,
  branch?: string,
): Config {
  return {
    git: {
      repository: { cloneUrl, ...(branch ? { branch } : {}) },
    },
    application: {},
    repoDir,
  } as unknown as Config;
}

describe("cloneCommand", () => {
  const askpass = "/data/askpass.sh";

  test("branch-on-remote clone is a single argv with env, no shell tokens", () => {
    const cmd = cloneCommand({
      cloneUrl: "https://x@github.com/org/repo.git",
      dir: "C:\\Users\\John Doe\\deco\\repo",
      branchOnRemote: "main",
      askpassPath: askpass,
    });
    expect(cmd.argv).toEqual([
      "git",
      "-c",
      "safe.directory=*",
      "-c",
      "credential.helper=",
      "-c",
      "http.connectTimeout=10",
      "-c",
      "http.lowSpeedLimit=1",
      "-c",
      "http.lowSpeedTime=10",
      "clone",
      "--depth",
      "1",
      "--branch",
      "main",
      "https://x@github.com/org/repo.git",
      "C:\\Users\\John Doe\\deco\\repo",
    ]);
    expect(cmd.env).toEqual({
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: askpass,
    });
  });

  test("default clone omits --branch", () => {
    const cmd = cloneCommand({
      cloneUrl: "https://g/r.git",
      dir: "/tmp/repo dir",
      branchOnRemote: null,
      askpassPath: askpass,
    });
    expect(cmd.argv.slice(-2)).toEqual(["https://g/r.git", "/tmp/repo dir"]);
    expect(cmd.argv).not.toContain("--branch");
  });
});

describe("spawnClone", () => {
  it("clones the target branch directly when it exists on remote", async () => {
    const { url, root, cleanup } = setupBareRepo();
    try {
      const repoDir = join(root, "workspace");
      const { code } = await spawnClone({
        config: makeConfig(repoDir, url, "feature/x"),
        askpassPath: ASKPASS,
        onChunk: () => {},
      });
      expect(code).toBe(0);
      expect(currentBranch(repoDir)).toBe("feature/x");
      // The clone landed on feature/x — the file unique to that branch is present.
      expect(existsSync(join(repoDir, "feature.txt"))).toBe(true);
    } finally {
      cleanup();
    }
  }, 30_000);

  it("fetches the base branch so divergence vs base is computable (case 2)", async () => {
    const { url, root, cleanup } = setupBareRepo();
    try {
      const repoDir = join(root, "workspace");
      const { code, fetchBase } = await spawnClone({
        config: makeConfig(repoDir, url, "feature/x"),
        askpassPath: ASKPASS,
        onChunk: () => {},
      });
      expect(code).toBe(0);
      // The base fetch is deferred off the clone critical path; the
      // orchestrator runs the returned thunk in the background. Drive it here
      // to assert the same side effects.
      expect(fetchBase).toBeDefined();
      await fetchBase?.(() => {});
      // Even though only feature/x was cloned, origin/main must be present with
      // origin/HEAD pointing at it — otherwise computeBranchDivergence can't
      // compute ahead/behind vs base and the header falsely shows "Up to date".
      // Assert the two artifacts fetchBaseBranch produces directly, so a
      // regression that drops the fetch or the symbolic-ref step is caught
      // (aheadOfBase alone would survive it via the "main" default fallback).
      expect(
        tryGitOut(
          repoDir,
          "rev-parse --verify --quiet refs/remotes/origin/main",
        ),
      ).toBeTruthy();
      expect(
        tryGitOut(repoDir, "symbolic-ref --short refs/remotes/origin/HEAD"),
      ).toBe("origin/main");
      const div = computeBranchDivergence(repoDir);
      expect(div.base).toBe("main");
      // feature/x has a commit that main does not — the button gates on
      // aheadOfBase > 0. (Exact counts are approximate on shallow clones and
      // not asserted; they aren't surfaced in the UI.)
      expect(div.aheadOfBase).toBeGreaterThan(0);
    } finally {
      cleanup();
    }
  }, 30_000);

  it("does not re-fetch the base when resuming the default branch itself", async () => {
    const { url, root, cleanup } = setupBareRepo();
    try {
      const repoDir = join(root, "workspace");
      // Resuming `main` (the default) hits the `base === branchOnRemote` skip:
      // the base is already the cloned branch, so the deferred fetch is a
      // no-op (it early-returns without a second network fetch).
      const { code, fetchBase } = await spawnClone({
        config: makeConfig(repoDir, url, "main"),
        askpassPath: ASKPASS,
        onChunk: () => {},
      });
      expect(code).toBe(0);
      await fetchBase?.(() => {});
      expect(currentBranch(repoDir)).toBe("main");
      const div = computeBranchDivergence(repoDir);
      expect(div.base).toBe("main");
      expect(div.aheadOfBase).toBe(0);
    } finally {
      cleanup();
    }
  }, 30_000);

  it("refuses a maliciously named default branch instead of running it", async () => {
    const { url, root, cleanup, bare } = setupBareRepo();
    try {
      // Git permits `;`/`$()`/backticks in ref names; the default branch name
      // flows into `sh -c` git commands, so an unsafe name must be rejected
      // before interpolation rather than executed.
      const evil = "x;whoami";
      const mainSha = execSync(`git -C ${bare} rev-parse refs/heads/main`)
        .toString()
        .trim();
      execSync(`git -C ${bare} branch '${evil}' ${mainSha}`, {
        stdio: "ignore",
      });
      execSync(`git -C ${bare} symbolic-ref HEAD 'refs/heads/${evil}'`, {
        stdio: "ignore",
      });

      const repoDir = join(root, "workspace");
      const { code, fetchBase } = await spawnClone({
        config: makeConfig(repoDir, url, "feature/x"),
        askpassPath: ASKPASS,
        onChunk: () => {},
      });
      // Best-effort: the clone still succeeds; it just skips the unsafe base.
      expect(code).toBe(0);
      // The unsafe-ref rejection lives in the deferred base fetch — drive it.
      await fetchBase?.(() => {});
      // origin/HEAD must NOT have been pointed at the malicious ref.
      expect(
        tryGitOut(repoDir, "symbolic-ref --short refs/remotes/origin/HEAD"),
      ).not.toBe(`origin/${evil}`);
      expect(
        tryGitOut(
          repoDir,
          `rev-parse --verify --quiet 'refs/remotes/origin/${evil}'`,
        ),
      ).toBeNull();
    } finally {
      cleanup();
    }
  }, 30_000);

  it("rejects a malicious requested branch instead of shelling it out", async () => {
    const { url, root, cleanup } = setupBareRepo();
    try {
      const repoDir = join(root, "workspace");
      // `branch` comes from tenant-supplied config and is interpolated into
      // `sh -c` git commands (ls-remote/clone/checkout) before any other
      // check runs — an unsafe name must be rejected before it ever reaches
      // a shell string instead of executing as a second command.
      const marker = join(root, "INJECTED");
      const { code } = await spawnClone({
        config: makeConfig(repoDir, url, `x;touch ${marker}`),
        askpassPath: ASKPASS,
        onChunk: () => {},
      });
      expect(code).not.toBe(0);
      expect(existsSync(marker)).toBe(false);
    } finally {
      cleanup();
    }
  }, 30_000);

  it("clones default and forks a local branch when target is missing on remote", async () => {
    const { url, root, cleanup } = setupBareRepo();
    try {
      const repoDir = join(root, "workspace");
      const { code } = await spawnClone({
        config: makeConfig(repoDir, url, "feature/new"),
        askpassPath: ASKPASS,
        onChunk: () => {},
      });
      expect(code).toBe(0);
      // Local branch was created from default (main); feature/x's exclusive
      // file should NOT be present, README.md (from main) should be.
      expect(currentBranch(repoDir)).toBe("feature/new");
      expect(existsSync(join(repoDir, "README.md"))).toBe(true);
      expect(existsSync(join(repoDir, "feature.txt"))).toBe(false);
    } finally {
      cleanup();
    }
  }, 30_000);

  it("clones the default branch when no branch is specified", async () => {
    const { url, root, cleanup } = setupBareRepo();
    try {
      const repoDir = join(root, "workspace");
      const { code } = await spawnClone({
        config: makeConfig(repoDir, url),
        askpassPath: ASKPASS,
        onChunk: () => {},
      });
      expect(code).toBe(0);
      expect(currentBranch(repoDir)).toBe("main");
    } finally {
      cleanup();
    }
  }, 30_000);

  it("rejects a relative repoDir instead of cloning into it", async () => {
    const chunks: string[] = [];
    const { code } = await spawnClone({
      config: makeConfig("relative/workspace", "file:///irrelevant.git"),
      askpassPath: ASKPASS,
      onChunk: (_source, data) => chunks.push(data),
    });
    expect(code).toBe(1);
    expect(chunks.join("")).toContain("not an absolute path");
  });

  it("fails with a non-zero exit when ls-remote cannot reach the remote", async () => {
    const { root, cleanup } = setupBareRepo();
    try {
      const repoDir = join(root, "workspace");
      // file:// URL pointing at a path that doesn't exist — ls-remote returns
      // a fatal error (not exit 2), so spawnClone must surface a non-zero
      // exit code instead of silently falling through to a local fork.
      const { code } = await spawnClone({
        config: makeConfig(
          repoDir,
          "file:///nonexistent/path/to/repo.git",
          "feature/x",
        ),
        askpassPath: ASKPASS,
        onChunk: () => {},
      });
      expect(code).not.toBe(0);
      expect(existsSync(repoDir)).toBe(false);
    } finally {
      cleanup();
    }
  }, 30_000);

  it("clones into a non-empty dir without .git via init+fetch", async () => {
    const { url, root, cleanup } = setupBareRepo();
    try {
      const repoDir = join(root, "workspace");
      mkdirSync(repoDir);
      // Pre-populate with a non-.git file — mimics .decocms/daemon.json being
      // written before the first clone. spawnClone must fall back to
      // init + fetch + checkout instead of `git clone`.
      writeFileSync(join(repoDir, "marker.txt"), "preexisting\n");
      const { code } = await spawnClone({
        config: makeConfig(repoDir, url, "feature/x"),
        askpassPath: ASKPASS,
        onChunk: () => {},
      });
      expect(code).toBe(0);
      expect(currentBranch(repoDir)).toBe("feature/x");
      expect(existsSync(join(repoDir, "marker.txt"))).toBe(true);
      expect(existsSync(join(repoDir, "feature.txt"))).toBe(true);
    } finally {
      cleanup();
    }
  }, 30_000);

  it("lands on the default branch (not detached HEAD) via init+fetch when no branch is requested", async () => {
    const { url, root, cleanup } = setupBareRepo();
    try {
      const repoDir = join(root, "workspace");
      mkdirSync(repoDir);
      // Same pre-populated-dir scenario as above, but with no branch
      // requested — this must still land on a real local branch (`main`),
      // matching what a plain `git clone` (no --branch) does, not a
      // detached FETCH_HEAD checkout.
      writeFileSync(join(repoDir, "marker.txt"), "preexisting\n");
      const { code } = await spawnClone({
        config: makeConfig(repoDir, url),
        askpassPath: ASKPASS,
        onChunk: () => {},
      });
      expect(code).toBe(0);
      expect(currentBranch(repoDir)).toBe("main");
      expect(existsSync(join(repoDir, "marker.txt"))).toBe(true);
    } finally {
      cleanup();
    }
  }, 30_000);
});

describe("prepareSubmoduleCredentials", () => {
  it("builds one store-file line per host with a percent-encoded token", () => {
    const { lines, hosts, invalidHosts } = prepareSubmoduleCredentials([
      { host: "github.com", token: "ghp_abc" },
    ]);
    expect(hosts).toEqual(["github.com"]);
    expect(lines).toEqual(["https://x-access-token:ghp_abc@github.com"]);
    expect(invalidHosts).toEqual([]);
  });

  it("percent-encodes tokens with URL-unsafe characters", () => {
    const { lines } = prepareSubmoduleCredentials([
      { host: "github.com", token: "a/b@c:d e" },
    ]);
    expect(lines).toEqual([
      "https://x-access-token:a%2Fb%40c%3Ad%20e@github.com",
    ]);
  });

  it("dedupes by host, last token wins", () => {
    const { lines, hosts } = prepareSubmoduleCredentials([
      { host: "github.com", token: "first" },
      { host: "github.com", token: "second" },
    ]);
    expect(hosts).toEqual(["github.com"]);
    expect(lines).toEqual(["https://x-access-token:second@github.com"]);
  });

  it("rejects hosts with a scheme, path, userinfo, or whitespace", () => {
    const { hosts, invalidHosts } = prepareSubmoduleCredentials([
      { host: "https://github.com", token: "t" },
      { host: "github.com/foo", token: "t" },
      { host: "evil@github.com", token: "t" },
      { host: "git hub.com", token: "t" },
      { host: "github.com:443", token: "ok" },
    ]);
    // Only the bare host (optionally with a port) survives.
    expect(hosts).toEqual(["github.com:443"]);
    expect(invalidHosts).toEqual([
      "https://github.com",
      "github.com/foo",
      "evil@github.com",
      "git hub.com",
    ]);
  });
});

describe("submoduleUpdateArgs", () => {
  it("emits SSH→HTTPS insteadOf rewrites (no token) then the store helper", () => {
    const args = submoduleUpdateArgs({
      hosts: ["github.com"],
      credFile: "/data/submodule-git-credentials",
    });
    expect(args).toEqual([
      "-c",
      "url.https://github.com/.insteadOf=git@github.com:",
      "-c",
      "url.https://github.com/.insteadOf=ssh://git@github.com/",
      "-c",
      "credential.helper=store --file=/data/submodule-git-credentials",
      "submodule",
      "update",
      "--init",
      "--recursive",
      "--depth",
      "1",
    ]);
    // The token must never appear in argv — only the credentials file holds it.
    expect(args.join(" ")).not.toContain("x-access-token");
  });

  it("emits rewrites for every host before the shared helper", () => {
    const args = submoduleUpdateArgs({
      hosts: ["github.com", "gitlab.example.com"],
      credFile: "/data/creds",
    });
    expect(args.filter((a) => a.startsWith("url.")).length).toBe(4);
    expect(args).toContain(
      "url.https://gitlab.example.com/.insteadOf=git@gitlab.example.com:",
    );
    // The store helper + subcommand always come last, after every rewrite.
    expect(args.slice(-8)).toEqual([
      "-c",
      "credential.helper=store --file=/data/creds",
      "submodule",
      "update",
      "--init",
      "--recursive",
      "--depth",
      "1",
    ]);
  });
});

/**
 * Like setupBareRepo but the default branch carries a real submodule gitlink
 * (+ `.gitmodules`) pointing at a `file://` sub-repo. The seed uses
 * `protocol.file.allow=always` to register it, but `spawnClone`'s submodule
 * update runs WITHOUT that flag — so git ≥2.38 blocks the file transport
 * (CVE-2022-39253) and the fetch fails fast. That's exactly the best-effort
 * path we want to prove doesn't take down the clone. (The top-level `git clone`
 * of the main repo still works — the block is submodule-initiated only.)
 */
function setupBareRepoWithGitmodules(): {
  url: string;
  root: string;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "clonetest-sm-"));
  const bare = join(root, "origin.git");
  const seed = join(root, "seed");
  const subBare = join(root, "sub.git");
  const subSeed = join(root, "sub-seed");
  const gitOpts = { stdio: "ignore" as const };
  const gitcfg = `-c init.defaultBranch=main -c user.email=test@example.com -c user.name=test -c commit.gpgsign=false`;
  // A tiny bare sub-repo to serve as the submodule source.
  execSync(`git ${gitcfg} init --bare ${subBare}`, gitOpts);
  execSync(`git ${gitcfg} init ${subSeed}`, gitOpts);
  writeFileSync(join(subSeed, "lib.txt"), "lib\n");
  execSync(`git ${gitcfg} -C ${subSeed} add .`, gitOpts);
  execSync(`git ${gitcfg} -C ${subSeed} commit -m sub`, gitOpts);
  execSync(`git ${gitcfg} -C ${subSeed} branch -M main`, gitOpts);
  execSync(`git ${gitcfg} -C ${subSeed} remote add origin ${subBare}`, gitOpts);
  execSync(`git ${gitcfg} -C ${subSeed} push -u origin main`, gitOpts);

  execSync(`git ${gitcfg} init --bare ${bare}`, gitOpts);
  execSync(`git ${gitcfg} init ${seed}`, gitOpts);
  writeFileSync(join(seed, "README.md"), "hello\n");
  execSync(`git ${gitcfg} -C ${seed} add .`, gitOpts);
  execSync(`git ${gitcfg} -C ${seed} commit -m initial`, gitOpts);
  // `submodule add` needs protocol.file.allow at seed time to register a
  // file:// submodule; the clone under test deliberately does not set it.
  execSync(
    `git ${gitcfg} -c protocol.file.allow=always -C ${seed} submodule add file://${subBare} vendor/lib`,
    gitOpts,
  );
  execSync(`git ${gitcfg} -C ${seed} commit -m submodule`, gitOpts);
  execSync(`git ${gitcfg} -C ${seed} branch -M main`, gitOpts);
  execSync(`git ${gitcfg} -C ${seed} remote add origin ${bare}`, gitOpts);
  execSync(`git ${gitcfg} -C ${seed} push -u origin main`, gitOpts);
  execSync(
    `git ${gitcfg} -C ${bare} symbolic-ref HEAD refs/heads/main`,
    gitOpts,
  );
  return {
    url: `file://${bare}`,
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function configWithSubmoduleCreds(
  repoDir: string,
  cloneUrl: string,
  submoduleCredentials: { host: string; token: string }[],
): Config {
  return {
    git: { repository: { cloneUrl, submoduleCredentials } },
    application: {},
    repoDir,
  } as unknown as Config;
}

describe("spawnClone — submodules", () => {
  it("is best-effort: a failing submodule fetch warns but the clone succeeds", async () => {
    const { url, root, cleanup } = setupBareRepoWithGitmodules();
    try {
      const repoDir = join(root, "workspace");
      // credFile is written next to askpass — point it at the writable test
      // root, not the daemon's /data (which the test env may not have).
      const askpassPath = join(root, "askpass.sh");
      let out = "";
      const { code } = await spawnClone({
        config: configWithSubmoduleCreds(repoDir, url, [
          { host: "github.com", token: "ghp_dummy" },
        ]),
        askpassPath,
        onChunk: (_src, data) => {
          out += data;
        },
      });
      // The bogus submodule fetch fails, but the working tree is intact.
      expect(code).toBe(0);
      expect(existsSync(join(repoDir, "README.md"))).toBe(true);
      expect(out).toContain("submodule update failed");
      // The temp credentials file must not survive the run.
      expect(existsSync(join(root, "submodule-git-credentials"))).toBe(false);
    } finally {
      cleanup();
    }
  }, 30_000);

  it("warns and skips an invalid host without running the submodule fetch", async () => {
    const { url, root, cleanup } = setupBareRepoWithGitmodules();
    try {
      const repoDir = join(root, "workspace");
      let out = "";
      const { code } = await spawnClone({
        config: configWithSubmoduleCreds(repoDir, url, [
          { host: "https://evil.com", token: "ghp_dummy" },
        ]),
        askpassPath: join(root, "askpass.sh"),
        onChunk: (_src, data) => {
          out += data;
        },
      });
      expect(code).toBe(0);
      expect(out).toContain("invalid host");
      // No valid host → the git submodule step never runs.
      expect(out).not.toContain("submodule update failed");
    } finally {
      cleanup();
    }
  }, 30_000);

  it("no-ops when credentials are set but the repo has no .gitmodules", async () => {
    const { url, root, cleanup } = setupBareRepo();
    try {
      const repoDir = join(root, "workspace");
      let out = "";
      const { code } = await spawnClone({
        config: configWithSubmoduleCreds(repoDir, url, [
          { host: "github.com", token: "ghp_dummy" },
        ]),
        askpassPath: join(root, "askpass.sh"),
        onChunk: (_src, data) => {
          out += data;
        },
      });
      expect(code).toBe(0);
      expect(out).not.toContain("submodule");
    } finally {
      cleanup();
    }
  }, 30_000);

  it("swallows a credentials-file write error and still succeeds", async () => {
    const { url, root, cleanup } = setupBareRepoWithGitmodules();
    try {
      const repoDir = join(root, "workspace");
      // askpass dir doesn't exist → the credFile write throws ENOENT, which the
      // best-effort catch must swallow rather than fail the clone.
      let out = "";
      const { code } = await spawnClone({
        config: configWithSubmoduleCreds(repoDir, url, [
          { host: "github.com", token: "ghp_dummy" },
        ]),
        askpassPath: join(root, "does-not-exist", "askpass.sh"),
        onChunk: (_src, data) => {
          out += data;
        },
      });
      expect(code).toBe(0);
      expect(existsSync(join(repoDir, "README.md"))).toBe(true);
      expect(out).toContain("submodule update errored");
    } finally {
      cleanup();
    }
  }, 30_000);
});
