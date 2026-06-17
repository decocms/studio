import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { cloneUrlHasCredentials, syncOriginRemote } from "./sync-origin-remote";

describe("cloneUrlHasCredentials", () => {
  it("detects embedded token userinfo", () => {
    expect(
      cloneUrlHasCredentials(
        "https://x-access-token:ghs_abc@github.com/org/repo.git",
      ),
    ).toBe(true);
  });

  it("returns false for anonymous HTTPS clone URLs", () => {
    expect(cloneUrlHasCredentials("https://github.com/org/repo.git")).toBe(
      false,
    );
  });
});

describe("syncOriginRemote", () => {
  it("updates origin remote URL", () => {
    const dir = mkdtempSync(join(tmpdir(), "sync-origin-"));
    const gitcfg =
      "-c user.email=test@example.com -c user.name=test -c commit.gpgsign=false";
    try {
      execSync(`git ${gitcfg} init --bare repo.git`, {
        cwd: dir,
        stdio: "ignore",
      });
      execSync(`git ${gitcfg} clone repo.git work`, {
        cwd: dir,
        stdio: "ignore",
      });
      const repoDir = join(dir, "work");
      const credentialed =
        "https://x-access-token:NEW_TOKEN@github.com/org/repo.git";
      syncOriginRemote(repoDir, credentialed);
      const origin = execSync(
        `git ${gitcfg} -C ${repoDir} remote get-url origin`,
        {
          encoding: "utf-8",
        },
      ).trim();
      expect(origin).toBe(credentialed);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
