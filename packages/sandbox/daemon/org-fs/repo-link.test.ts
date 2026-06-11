import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ensureRepoOrgLink } from "./repo-link";

describe("ensureRepoOrgLink", () => {
  let appRoot: string;
  const repo = () => join(appRoot, "repo");

  beforeEach(() => {
    appRoot = mkdtempSync(join(tmpdir(), "orgfs-rl-"));
    mkdirSync(join(appRoot, "org", "skills"), { recursive: true });
    mkdirSync(join(repo(), ".git", "info"), { recursive: true });
    writeFileSync(join(repo(), ".git", "info", "exclude"), "# default\n");
  });
  afterEach(() => {
    rmSync(appRoot, { recursive: true, force: true });
  });

  it("creates a relative link and git-excludes it", async () => {
    await ensureRepoOrgLink(repo());
    expect(readlinkSync(join(repo(), "org"))).toBe("../org");
    expect(
      readFileSync(join(repo(), ".git", "info", "exclude"), "utf8"),
    ).toContain("/org");
  });

  it("is idempotent (no duplicate exclude lines)", async () => {
    await ensureRepoOrgLink(repo());
    await ensureRepoOrgLink(repo());
    const lines = readFileSync(join(repo(), ".git", "info", "exclude"), "utf8")
      .split("\n")
      .filter((l) => l === "/org");
    expect(lines.length).toBe(1);
  });

  it("never shadows a real org/ dir in the repo", async () => {
    rmSync(join(repo(), "org"), { force: true });
    mkdirSync(join(repo(), "org"));
    writeFileSync(join(repo(), "org", "user-file.txt"), "real content");
    await ensureRepoOrgLink(repo());
    expect(readFileSync(join(repo(), "org", "user-file.txt"), "utf8")).toBe(
      "real content",
    );
  });

  it("tolerates a repo without .git (ephemeral sandboxes)", async () => {
    rmSync(join(repo(), ".git"), { recursive: true, force: true });
    await ensureRepoOrgLink(repo());
    expect(readlinkSync(join(repo(), "org"))).toBe("../org");
  });

  it("creates info/exclude when .git exists without it (template-less clones)", async () => {
    rmSync(join(repo(), ".git", "info"), { recursive: true, force: true });
    await ensureRepoOrgLink(repo());
    expect(
      readFileSync(join(repo(), ".git", "info", "exclude"), "utf8")
        .split("\n")
        .includes("/org"),
    ).toBe(true);
  });
});
