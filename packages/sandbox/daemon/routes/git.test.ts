import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "bun:test";
import { gitSync } from "../git/git-sync";
import {
  makeGitDiffHandler,
  makeGitDiscardHandler,
  makeGitPublishHandler,
  makeGitStatusHandler,
} from "./git";

function initRepo(): { appRoot: string; repoDir: string } {
  const appRoot = mkdtempSync(join(tmpdir(), "git-route-root-"));
  const repoDir = join(appRoot, "app");
  mkdirSync(repoDir, { recursive: true });
  gitSync(["init", "-b", "main"], { cwd: repoDir, asUser: false });
  gitSync(["config", "user.email", "test@example.com"], {
    cwd: repoDir,
    asUser: false,
  });
  gitSync(["config", "user.name", "Test"], { cwd: repoDir, asUser: false });
  writeFileSync(join(repoDir, "README.md"), "hello\n");
  gitSync(["add", "README.md"], { cwd: repoDir, asUser: false });
  gitSync(["commit", "-m", "init"], { cwd: repoDir, asUser: false });
  return { appRoot, repoDir };
}

describe("git routes", () => {
  it("status reports modified files", async () => {
    const { appRoot, repoDir } = initRepo();
    writeFileSync(join(repoDir, "README.md"), "hello world\n");
    const handler = makeGitStatusHandler({ appRoot, repoDir });
    const res = await handler(new Request("http://x/git/status"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { modified: string[] };
    expect(body.modified).toContain("README.md");
  });

  it("diff returns before/after content", async () => {
    const { appRoot, repoDir } = initRepo();
    writeFileSync(join(repoDir, "README.md"), "hello world\n");
    const handler = makeGitDiffHandler({ appRoot, repoDir });
    const res = await handler(new Request("http://x/git/diff"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      diffs: Record<string, { from: string | null; to: string | null }>;
    };
    expect(body.diffs["README.md"]?.from).toContain("hello");
    expect(body.diffs["README.md"]?.to).toContain("hello world");
  });

  it("publish commits staged changes", async () => {
    const { appRoot, repoDir } = initRepo();
    writeFileSync(join(repoDir, "README.md"), "updated\n");
    const handler = makeGitPublishHandler({ appRoot, repoDir });
    const res = await handler(
      new Request("http://x/git/publish", {
        method: "POST",
        body: JSON.stringify({ message: "update readme" }),
      }),
    );
    // No remote configured in this fixture — push fails, but commit should land.
    if (res.status === 500) {
      const log = gitSync(["log", "-1", "--pretty=%s"], {
        cwd: repoDir,
        asUser: false,
      });
      expect(log.trim()).toBe("update readme");
      return;
    }
    expect(res.status).toBe(200);
  });

  it("publish skips failing pre-commit hooks", async () => {
    const { appRoot, repoDir } = initRepo();
    const hooksDir = join(repoDir, ".git", "hooks");
    mkdirSync(hooksDir, { recursive: true });
    const hookPath = join(hooksDir, "pre-commit");
    writeFileSync(hookPath, "#!/bin/sh\nexit 1\n");
    chmodSync(hookPath, 0o755);

    writeFileSync(join(repoDir, "README.md"), "hook-bypass\n");
    const handler = makeGitPublishHandler({ appRoot, repoDir });
    const res = await handler(
      new Request("http://x/git/publish", {
        method: "POST",
        body: JSON.stringify({ message: "skip hooks" }),
      }),
    );

    if (res.status === 500) {
      const log = gitSync(["log", "-1", "--pretty=%s"], {
        cwd: repoDir,
        asUser: false,
      });
      expect(log.trim()).toBe("skip hooks");
      return;
    }
    expect(res.status).toBe(200);
  });

  it("publish stages only paths with working tree changes", async () => {
    const { appRoot, repoDir } = initRepo();
    writeFileSync(join(repoDir, "tracked.txt"), "original\n");
    gitSync(["add", "tracked.txt"], { cwd: repoDir, asUser: false });
    gitSync(["commit", "-m", "add tracked"], { cwd: repoDir, asUser: false });

    writeFileSync(join(repoDir, "README.md"), "updated\n");

    const handler = makeGitPublishHandler({ appRoot, repoDir });
    const res = await handler(
      new Request("http://x/git/publish", {
        method: "POST",
        body: JSON.stringify({ message: "only readme" }),
      }),
    );

    if (res.status === 500) {
      const log = gitSync(["log", "-1", "--pretty=%s"], {
        cwd: repoDir,
        asUser: false,
      });
      expect(log.trim()).toBe("only readme");
      const show = gitSync(["show", "--name-only", "--pretty=", "HEAD"], {
        cwd: repoDir,
        asUser: false,
      });
      expect(show.trim()).toBe("README.md");
      return;
    }
    expect(res.status).toBe(200);
  });

  it("discard rejects path traversal", async () => {
    const { appRoot, repoDir } = initRepo();
    const outside = join(dirname(appRoot), "outside-secret.txt");
    writeFileSync(outside, "secret\n");

    const handler = makeGitDiscardHandler({ appRoot, repoDir });
    const res = await handler(
      new Request("http://x/git/discard", {
        method: "POST",
        body: JSON.stringify({ filepaths: ["../outside-secret.txt"] }),
      }),
    );

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: "Invalid path: ../outside-secret.txt",
    });
  });
});
