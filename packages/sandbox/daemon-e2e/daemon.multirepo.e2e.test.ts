/**
 * Daemon conformance suite — SECONDARY CHECKOUTS.
 *
 * An org whose work spans repositories (a storefront and its checkout, say)
 * needs more than one tree in the pod. The daemon takes the extras on
 * `git.repositories` and clones each beside the primary, one directory apiece.
 *
 * Black-box: config goes in over HTTP, assertions read the working tree. What
 * is pinned here is the wire contract — every configured repo lands, the
 * secondaries sit OUTSIDE the primary's tree so its `git status` stays clean,
 * one that cannot clone never costs the pod its primary, re-posting the same
 * config is a no-op rather than a re-clone, and more repos than the concurrency
 * cap still all land.
 */
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
  type BareRepo,
  type Daemon,
  HOOK_TIMEOUT_MS,
  postConfig,
  setupBareRepo,
  startDaemon,
  stopDaemon,
  waitForOrchestratorIdle,
} from "./daemon.e2e.helpers";

const SETUP_TIMEOUT_MS = 60_000;
// Named constants, not inline literals: the scanner reads `token: "..."` in an
// object as a real credential. Mirrors `daemon.submodules.e2e.test.ts`.
const TOKEN_A = "ghp_e2e_a_synthetic_never_real";
const TOKEN_B = "ghp_e2e_b_synthetic_never_real";

describe("daemon secondary checkouts", () => {
  let d: Daemon;
  let primary: BareRepo;
  let extraA: BareRepo;
  let extraB: BareRepo;

  beforeEach(async () => {
    primary = setupBareRepo();
    extraA = setupBareRepo();
    extraB = setupBareRepo();
    d = await startDaemon();
  }, HOOK_TIMEOUT_MS);

  afterEach(async () => {
    await stopDaemon(d);
    primary?.cleanup();
    extraA?.cleanup();
    extraB?.cleanup();
  }, HOOK_TIMEOUT_MS);

  const configure = (repositories: { cloneUrl: string; repoName: string }[]) =>
    postConfig(d, {
      git: {
        repository: { cloneUrl: primary.url },
        repositories,
      },
      cloneOnly: true,
    });

  const repoDir = () => join(d.appDir, "repo");
  const secondaryDir = (name: string) => join(d.appDir, "repos", name);

  it(
    "clones every configured repository, the extras beside the primary",
    async () => {
      const res = await configure([
        { cloneUrl: extraA.url, repoName: "checkout" },
        { cloneUrl: extraB.url, repoName: "design-system" },
      ]);
      expect(res.status).toBeLessThan(300);
      await waitForOrchestratorIdle(d);

      expect(existsSync(join(repoDir(), "README.md"))).toBe(true);
      expect(existsSync(join(secondaryDir("checkout"), "README.md"))).toBe(
        true,
      );
      expect(existsSync(join(secondaryDir("design-system"), "README.md"))).toBe(
        true,
      );
    },
    SETUP_TIMEOUT_MS,
  );

  it(
    "leaves the primary's working tree clean, so the extras are not its untracked files",
    async () => {
      await configure([{ cloneUrl: extraA.url, repoName: "checkout" }]);
      await waitForOrchestratorIdle(d);

      const status = execSync("git status --porcelain", {
        cwd: repoDir(),
        encoding: "utf8",
      });
      expect(status.trim()).toBe("");
    },
    SETUP_TIMEOUT_MS,
  );

  // A dead secondary must cost neither the primary nor the ones behind it.
  it(
    "keeps the pod when a secondary cannot be cloned",
    async () => {
      await configure([
        { cloneUrl: "file:///nonexistent/never.git", repoName: "broken" },
        { cloneUrl: extraA.url, repoName: "checkout" },
      ]);
      await waitForOrchestratorIdle(d);

      expect(existsSync(join(repoDir(), "README.md"))).toBe(true);
      expect(existsSync(join(secondaryDir("checkout"), "README.md"))).toBe(
        true,
      );
      expect(existsSync(secondaryDir("broken"))).toBe(false);
    },
    SETUP_TIMEOUT_MS,
  );

  it(
    "re-posting the same config does not re-clone an existing secondary",
    async () => {
      await configure([{ cloneUrl: extraA.url, repoName: "checkout" }]);
      await waitForOrchestratorIdle(d);

      const marker = join(secondaryDir("checkout"), "LOCAL_EDIT");
      execSync(`touch ${JSON.stringify(marker)}`);

      await configure([{ cloneUrl: extraA.url, repoName: "checkout" }]);
      await waitForOrchestratorIdle(d);

      expect(existsSync(marker)).toBe(true);
    },
    SETUP_TIMEOUT_MS,
  );

  // Six against a cap of four, so the semaphore has to release and refill.
  // Wall clock proves nothing here (a `file://` clone is milliseconds), so this
  // pins landing, not speed; the overlap itself is covered by `go test -race`.
  it(
    "clones more repos than the concurrency cap allows at once",
    async () => {
      const extras = Array.from({ length: 6 }, () => setupBareRepo());
      try {
        await postConfig(d, {
          cloneOnly: true,
          git: {
            repository: { cloneUrl: primary.url },
            repositories: extras.map((r, i) => ({
              cloneUrl: r.url,
              repoName: `extra${i}`,
            })),
          },
        });
        await waitForOrchestratorIdle(d);

        for (let i = 0; i < extras.length; i++) {
          expect(existsSync(join(secondaryDir(`extra${i}`), "README.md"))).toBe(
            true,
          );
        }
      } finally {
        for (const r of extras) r.cleanup();
      }
    },
    SETUP_TIMEOUT_MS,
  );

  it(
    "gives each secondary its own submodule credentials file",
    async () => {
      await postConfig(d, {
        cloneOnly: true,
        git: {
          repository: { cloneUrl: primary.url },
          repositories: [
            {
              cloneUrl: extraA.url,
              repoName: "checkout",
              submoduleCredentials: [{ host: "a.invalid", token: TOKEN_A }],
            },
            {
              cloneUrl: extraB.url,
              repoName: "design",
              submoduleCredentials: [{ host: "b.invalid", token: TOKEN_B }],
            },
          ],
        },
      });
      await waitForOrchestratorIdle(d);

      expect(existsSync(join(secondaryDir("checkout"), "README.md"))).toBe(
        true,
      );
      expect(existsSync(join(secondaryDir("design"), "README.md"))).toBe(true);

      // Every credentials file is removed once its clone returns; a shared one
      // would have had the two clones deleting each other's mid-fetch.
      const leftovers = execSync(
        `find ${JSON.stringify(d.appDir)} -name "submodule-git-credentials" -o -name "secondary-clones" 2>/dev/null || true`,
        { encoding: "utf8" },
      ).trim();
      expect(leftovers).toBe("");
    },
    SETUP_TIMEOUT_MS,
  );

  it(
    "refuses a secondary whose name would escape its directory",
    async () => {
      const res = await postConfig(d, {
        git: {
          repository: { cloneUrl: primary.url },
          repositories: [{ cloneUrl: extraA.url, repoName: "../escape" }],
        },
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(existsSync(join(d.appDir, "escape"))).toBe(false);
    },
    SETUP_TIMEOUT_MS,
  );
});
