/**
 * Black-box durability contract for filesystem shutdown.
 *
 * A completed write survives in the worktree uncommitted across SIGTERM and
 * immediate same-root restart. Shutdown deliberately performs no git commit
 * or push, so the remote stays untouched.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { retry } from "@decocms/shared/std";
import { afterEach, expect, it } from "bun:test";

import {
  describeLocalApi,
  jsonAuthHeaders,
  startLocalApi,
  stopLocalApi,
  url,
  type LocalApi,
} from "./helpers";

const RETRY_OPTIONS = {
  maxAttempts: 200,
  minTimeout: 20,
  maxTimeout: 50,
  jitter: 0,
} as const;

let api: LocalApi | null = null;
let originRoot: string | null = null;

function git(cwd: string, args: string[], allowFailure = false): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (!allowFailure && result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed in ${cwd}: ${result.stderr || result.stdout}`,
    );
  }
  return result.stdout;
}

function configureOriginFixture(localApi: LocalApi): string {
  const root = mkdtempSync(join(tmpdir(), "native-fs-shutdown-origin-"));
  originRoot = root;
  const bare = join(root, "origin.git");
  const repo = join(localApi.workdir, "repo");
  git(root, ["init", "--bare", "-q", bare]);
  git(repo, ["init", "-q", "-b", "sandbox-work"]);
  git(repo, ["config", "user.name", "Filesystem Shutdown Test"]);
  git(repo, ["config", "user.email", "fs-shutdown@example.com"]);
  writeFileSync(join(repo, "baseline.txt"), "baseline\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "baseline"]);
  git(repo, ["remote", "add", "origin", bare]);
  git(repo, ["push", "-q", "-u", "origin", "sandbox-work"]);
  return bare;
}

afterEach(async () => {
  await stopLocalApi(api);
  api = null;
  if (originRoot) rmSync(originRoot, { recursive: true, force: true });
  originRoot = null;
});

describeLocalApi("local-api e2e: filesystem shutdown durability", () => {
  it("keeps completed work local and unpushed across shutdown", async () => {
    const first = await startLocalApi({ LOCAL_API_TOKEN_STORE: "memory" });
    api = first;
    const bare = configureOriginFixture(first);
    const repo = join(first.workdir, "repo");

    const completed = await fetch(url(first, "/_sandbox/write"), {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: JSON.stringify({
        path: "before-shutdown.txt",
        content: "must stay local\n",
      }),
    });
    expect(completed.status).toBe(200);

    const shutdownStartedAt = Date.now();
    expect(first.proc.kill("SIGTERM")).toBe(true);
    await retry(async () => {
      if (first.proc.exitCode === null && first.proc.signalCode === null) {
        throw new Error("local-api has not completed graceful shutdown");
      }
    }, RETRY_OPTIONS);

    expect(Date.now() - shutdownStartedAt).toBeLessThan(15_000);
    expect(first.proc.exitCode).toBe(0);
    expect(readFileSync(join(repo, "before-shutdown.txt"), "utf8")).toBe(
      "must stay local\n",
    );
    expect(git(repo, ["status", "--porcelain"])).toContain(
      "before-shutdown.txt",
    );
    const publishedToRemote = spawnSync(
      "git",
      ["show", "sandbox-work:before-shutdown.txt"],
      { cwd: bare, encoding: "utf8" },
    );
    expect(publishedToRemote.status).not.toBe(0);

    const restarted = await startLocalApi(
      { LOCAL_API_TOKEN_STORE: "memory" },
      { workdir: first.workdir },
    );
    api = restarted;
    const health = await fetch(url(restarted, "/health"));
    expect(health.status).toBe(200);
  }, 20_000);
});
