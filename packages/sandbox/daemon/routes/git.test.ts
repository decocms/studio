import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { gitSync } from "../git/git-sync";
import {
  makeGitDiffHandler,
  makeGitPublishHandler,
  makeGitStatusHandler,
} from "./git";

function initRepo(): string {
  const repoDir = mkdtempSync(join(tmpdir(), "git-route-"));
  gitSync(["init", "-b", "main"], { cwd: repoDir, asUser: false });
  gitSync(["config", "user.email", "test@example.com"], {
    cwd: repoDir,
    asUser: false,
  });
  gitSync(["config", "user.name", "Test"], { cwd: repoDir, asUser: false });
  writeFileSync(join(repoDir, "README.md"), "hello\n");
  gitSync(["add", "README.md"], { cwd: repoDir, asUser: false });
  gitSync(["commit", "-m", "init"], { cwd: repoDir, asUser: false });
  return repoDir;
}

describe("git routes", () => {
  it("status reports modified files", async () => {
    const repoDir = initRepo();
    writeFileSync(join(repoDir, "README.md"), "hello world\n");
    const handler = makeGitStatusHandler({ repoDir });
    const res = await handler(new Request("http://x/git/status"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { modified: string[] };
    expect(body.modified).toContain("README.md");
  });

  it("diff returns before/after content", async () => {
    const repoDir = initRepo();
    writeFileSync(join(repoDir, "README.md"), "hello world\n");
    const handler = makeGitDiffHandler({ repoDir });
    const res = await handler(new Request("http://x/git/diff"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      diffs: Record<string, { from: string | null; to: string | null }>;
    };
    expect(body.diffs["README.md"]?.from).toContain("hello");
    expect(body.diffs["README.md"]?.to).toContain("hello world");
  });

  it("publish commits staged changes", async () => {
    const repoDir = initRepo();
    writeFileSync(join(repoDir, "README.md"), "updated\n");
    const handler = makeGitPublishHandler({ repoDir });
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
    const repoDir = initRepo();
    const hooksDir = join(repoDir, ".git", "hooks");
    mkdirSync(hooksDir, { recursive: true });
    const hookPath = join(hooksDir, "pre-commit");
    writeFileSync(hookPath, "#!/bin/sh\nexit 1\n");
    chmodSync(hookPath, 0o755);

    writeFileSync(join(repoDir, "README.md"), "hook-bypass\n");
    const handler = makeGitPublishHandler({ repoDir });
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
});
