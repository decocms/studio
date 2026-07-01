import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import {
  type LinkSandboxRegistry,
  openLinkSandboxRegistry,
  registryPathForDataDir,
} from "./link-sandbox-registry";

const dirs: string[] = [];
const registries: LinkSandboxRegistry[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "deco-link-registry-"));
  dirs.push(dir);
  return dir;
}

function openRegistry(path: string): LinkSandboxRegistry {
  return trackRegistry(openLinkSandboxRegistry({ path }));
}

function trackRegistry(registry: LinkSandboxRegistry): LinkSandboxRegistry {
  registries.push(registry);
  return registry;
}

function closeRegistry(registry: LinkSandboxRegistry): void {
  const index = registries.indexOf(registry);
  if (index >= 0) {
    registries.splice(index, 1);
  }
  registry.close();
}

async function runGit(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${await new Response(proc.stderr).text()}`,
    );
  }
}

async function initRepo(path: string, defaultBranch = "main"): Promise<void> {
  mkdirSync(path, { recursive: true });
  await runGit(path, ["init", "-b", defaultBranch]);
  await runGit(path, ["config", "user.email", "test@example.com"]);
  await runGit(path, ["config", "user.name", "Test User"]);
  writeFileSync(join(path, "README.md"), "initial\n");
  await runGit(path, ["add", "README.md"]);
  await runGit(path, ["commit", "-m", "initial"]);
}

afterEach(() => {
  for (const registry of registries.splice(0).reverse()) {
    registry.close();
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("link sandbox registry", () => {
  it("stores and lists sandbox records by handle", () => {
    const dataDir = tempDir();
    const registry = openRegistry(registryPathForDataDir(dataDir));

    registry.upsert({
      handle: "abc123",
      status: "ready",
      sandboxPath: join(dataDir, "sandboxes", "abc123"),
      port: 5175,
      previewUrl: "http://abc123.localhost:5174",
      repoCloneUrl: "https://github.com/decocms/studio.git",
      branch: "feat/persist-link",
      projectName: "studio",
      error: null,
    });

    expect(registry.list()).toEqual([
      expect.objectContaining({
        handle: "abc123",
        status: "ready",
        port: 5175,
        previewUrl: "http://abc123.localhost:5174",
        branch: "feat/persist-link",
        projectName: "studio",
      }),
    ]);

    closeRegistry(registry);
  });

  it("reopens the sqlite file with existing rows", () => {
    const dataDir = tempDir();
    const path = registryPathForDataDir(dataDir);
    const first = openRegistry(path);
    first.upsert({
      handle: "reopen",
      status: "failed",
      sandboxPath: join(dataDir, "sandboxes", "reopen"),
      port: null,
      previewUrl: null,
      repoCloneUrl: null,
      branch: null,
      projectName: null,
      error: "clone failed",
    });
    closeRegistry(first);

    const second = openRegistry(path);
    expect(second.list()).toEqual([
      expect.objectContaining({
        handle: "reopen",
        status: "failed",
        error: "clone failed",
      }),
    ]);
    closeRegistry(second);
  });

  it("marks rows missing when the sandbox path no longer exists", () => {
    const dataDir = tempDir();
    const registry = trackRegistry(
      openLinkSandboxRegistry({
        path: registryPathForDataDir(dataDir),
        managedSandboxRoot: join(dataDir, "sandboxes"),
      }),
    );

    registry.upsert({
      handle: "gone",
      status: "ready",
      sandboxPath: join(dataDir, "sandboxes", "gone"),
      port: 1234,
      previewUrl: "http://gone.localhost:5174",
      repoCloneUrl: null,
      branch: "feat/gone",
      projectName: "studio",
      error: null,
    });

    const rows = registry.reconcile();
    expect(rows).toEqual([
      expect.objectContaining({
        handle: "gone",
        status: "missing",
        port: null,
        previewUrl: null,
      }),
    ]);
    expect(rows[0]?.missingSince).toBeNumber();
  });

  it("marks rows invalid when the path is outside the managed sandbox root", () => {
    const dataDir = tempDir();
    const registry = trackRegistry(
      openLinkSandboxRegistry({
        path: registryPathForDataDir(dataDir),
        managedSandboxRoot: join(dataDir, "sandboxes"),
      }),
    );

    registry.upsert({
      handle: "bad",
      status: "ready",
      sandboxPath: join(dataDir, "elsewhere", "bad"),
      port: 1234,
      previewUrl: "http://bad.localhost:5174",
      repoCloneUrl: null,
      branch: null,
      projectName: null,
      error: null,
    });

    expect(registry.reconcile()).toEqual([
      expect.objectContaining({
        handle: "bad",
        status: "invalid",
        error: "sandbox path is outside the managed sandbox root",
      }),
    ]);
  });

  it("marks symlinked sandbox paths invalid when they resolve outside the managed sandbox root", () => {
    const dataDir = tempDir();
    const managedSandboxRoot = join(dataDir, "sandboxes");
    const outsidePath = join(dataDir, "elsewhere", "bad");
    const symlinkPath = join(managedSandboxRoot, "bad");
    mkdirSync(outsidePath, { recursive: true });
    mkdirSync(managedSandboxRoot, { recursive: true });
    symlinkSync(outsidePath, symlinkPath, "dir");
    const registry = trackRegistry(
      openLinkSandboxRegistry({
        path: registryPathForDataDir(dataDir),
        managedSandboxRoot,
      }),
    );

    registry.upsert({
      handle: "bad-symlink",
      status: "ready",
      sandboxPath: symlinkPath,
      port: 1234,
      previewUrl: "http://bad-symlink.localhost:5174",
      repoCloneUrl: null,
      branch: null,
      projectName: null,
      error: null,
    });

    expect(registry.reconcile()).toEqual([
      expect.objectContaining({
        handle: "bad-symlink",
        status: "invalid",
        error: "sandbox path is outside the managed sandbox root",
      }),
    ]);
  });

  it("marks existing active sandbox paths stopped", () => {
    const dataDir = tempDir();
    const sandboxPath = join(dataDir, "sandboxes", "active");
    mkdirSync(sandboxPath, { recursive: true });
    const registry = trackRegistry(
      openLinkSandboxRegistry({
        path: registryPathForDataDir(dataDir),
        managedSandboxRoot: join(dataDir, "sandboxes"),
      }),
    );

    registry.upsert({
      handle: "active",
      status: "ready",
      sandboxPath,
      port: 1234,
      previewUrl: "http://active.localhost:5174",
      repoCloneUrl: null,
      branch: null,
      projectName: null,
      error: "old error",
    });

    const rows = registry.reconcile();
    expect(rows).toEqual([
      expect.objectContaining({
        handle: "active",
        status: "stopped",
        port: null,
        previewUrl: null,
        error: null,
        missingSince: null,
      }),
    ]);
    expect(rows[0]?.lastSeenAt).toBeNumber();
  });

  it("preserves source metadata when reconcile stops an existing ready sandbox", () => {
    const dataDir = tempDir();
    const managedSandboxRoot = join(dataDir, "sandboxes");
    const sandboxPath = join(managedSandboxRoot, "active-with-metadata");
    mkdirSync(sandboxPath, { recursive: true });
    const registry = trackRegistry(
      openLinkSandboxRegistry({
        path: registryPathForDataDir(dataDir),
        managedSandboxRoot,
      }),
    );

    registry.upsert({
      handle: "active-with-metadata",
      status: "ready",
      sandboxPath,
      port: 1234,
      previewUrl: "http://active-with-metadata.localhost:5174",
      repoCloneUrl: "https://github.com/decocms/studio.git",
      branch: "feat/metadata",
      projectName: "studio",
      error: null,
    });

    const rows = registry.reconcile();

    expect(rows).toEqual([
      expect.objectContaining({
        handle: "active-with-metadata",
        status: "stopped",
        port: null,
        previewUrl: null,
        repoCloneUrl: "https://github.com/decocms/studio.git",
        branch: "feat/metadata",
        projectName: "studio",
      }),
    ]);
  });

  it("uses one timestamp for all updates in a single reconciliation pass", () => {
    const dataDir = tempDir();
    const managedSandboxRoot = join(dataDir, "sandboxes");
    const outsidePath = join(dataDir, "elsewhere", "bad");
    const originalDateNow = Date.now;
    let timestamp = 1000;
    Date.now = () => timestamp++;

    try {
      const registry = trackRegistry(
        openLinkSandboxRegistry({
          path: registryPathForDataDir(dataDir),
          managedSandboxRoot,
        }),
      );

      registry.upsert({
        handle: "gone",
        status: "ready",
        sandboxPath: join(managedSandboxRoot, "gone"),
        port: 1234,
        previewUrl: "http://gone.localhost:5174",
        repoCloneUrl: null,
        branch: null,
        projectName: null,
        error: null,
      });
      registry.upsert({
        handle: "bad",
        status: "ready",
        sandboxPath: outsidePath,
        port: 1235,
        previewUrl: "http://bad.localhost:5174",
        repoCloneUrl: null,
        branch: null,
        projectName: null,
        error: null,
      });

      const rows = registry.reconcile();
      const gone = rows.find((row) => row.handle === "gone");
      const bad = rows.find((row) => row.handle === "bad");

      expect(gone?.status).toBe("missing");
      expect(bad?.status).toBe("invalid");
      expect(gone?.updatedAt).toBe(bad?.updatedAt);
      expect(gone?.missingSince).toBe(gone?.updatedAt);
    } finally {
      Date.now = originalDateNow;
    }
  });

  it("prunes metadata-only rows whose sandbox path is missing", () => {
    const dataDir = tempDir();
    const registry = trackRegistry(
      openLinkSandboxRegistry({
        path: registryPathForDataDir(dataDir),
        managedSandboxRoot: join(dataDir, "sandboxes"),
      }),
    );
    registry.upsert({
      handle: "missing",
      status: "ready",
      sandboxPath: join(dataDir, "sandboxes", "missing"),
      port: 1,
      previewUrl: "http://missing.localhost:5174",
      repoCloneUrl: null,
      branch: "feat/missing",
      projectName: "studio",
      error: null,
    });

    const result = registry.prune({ missing: true, merged: false });

    expect(result.removed).toEqual([
      expect.objectContaining({
        handle: "missing",
        reason: "missing",
        deletedFiles: false,
      }),
    ]);
    expect(registry.list()).toEqual([]);
  });

  it("skips pruning clean sandbox directories whose branch is not merged", async () => {
    const dataDir = tempDir();
    const sandboxPath = join(dataDir, "sandboxes", "live");
    await initRepo(sandboxPath);
    await runGit(sandboxPath, ["checkout", "-b", "feat/live"]);
    writeFileSync(join(sandboxPath, "feature.txt"), "live\n");
    await runGit(sandboxPath, ["add", "feature.txt"]);
    await runGit(sandboxPath, ["commit", "-m", "live feature"]);
    await runGit(sandboxPath, ["checkout", "main"]);
    const registry = trackRegistry(
      openLinkSandboxRegistry({
        path: registryPathForDataDir(dataDir),
        managedSandboxRoot: join(dataDir, "sandboxes"),
      }),
    );
    registry.upsert({
      handle: "live",
      status: "stopped",
      sandboxPath,
      port: null,
      previewUrl: null,
      repoCloneUrl: null,
      branch: "feat/live",
      projectName: "studio",
      error: null,
    });

    const result = registry.prune({ missing: false, merged: true });

    expect(result.removed).toEqual([]);
    expect(result.skipped).toEqual([
      expect.objectContaining({
        handle: "live",
        reason: "branch_not_merged",
        deletedFiles: false,
      }),
    ]);
    expect(registry.list()).toEqual([
      expect.objectContaining({ handle: "live" }),
    ]);
    expect(existsSync(sandboxPath)).toBe(true);
  });

  it("prunes clean sandbox directories whose branch is merged", async () => {
    const dataDir = tempDir();
    const sandboxPath = join(dataDir, "sandboxes", "done");
    await initRepo(sandboxPath);
    await runGit(sandboxPath, ["checkout", "-b", "feat/done"]);
    writeFileSync(join(sandboxPath, "feature.txt"), "done\n");
    await runGit(sandboxPath, ["add", "feature.txt"]);
    await runGit(sandboxPath, ["commit", "-m", "done feature"]);
    await runGit(sandboxPath, ["checkout", "main"]);
    await runGit(sandboxPath, [
      "merge",
      "--no-ff",
      "feat/done",
      "-m",
      "merge done",
    ]);
    const registry = trackRegistry(
      openLinkSandboxRegistry({
        path: registryPathForDataDir(dataDir),
        managedSandboxRoot: join(dataDir, "sandboxes"),
      }),
    );
    registry.upsert({
      handle: "done",
      status: "stopped",
      sandboxPath,
      port: null,
      previewUrl: null,
      repoCloneUrl: null,
      branch: "feat/done",
      projectName: "studio",
      error: null,
    });

    const result = registry.prune({ missing: false, merged: true });

    expect(result.removed).toEqual([
      expect.objectContaining({
        handle: "done",
        reason: "merged",
        deletedFiles: true,
      }),
    ]);
    expect(result.skipped).toEqual([]);
    expect(registry.list()).toEqual([]);
    expect(existsSync(sandboxPath)).toBe(false);
  });

  it("prunes merged branches when the default branch is not main", async () => {
    const dataDir = tempDir();
    const sandboxPath = join(dataDir, "sandboxes", "trunk-done");
    await initRepo(sandboxPath, "trunk");
    await runGit(sandboxPath, ["checkout", "-b", "feat/trunk-done"]);
    writeFileSync(join(sandboxPath, "feature.txt"), "done\n");
    await runGit(sandboxPath, ["add", "feature.txt"]);
    await runGit(sandboxPath, ["commit", "-m", "done feature"]);
    await runGit(sandboxPath, ["checkout", "trunk"]);
    await runGit(sandboxPath, [
      "merge",
      "--no-ff",
      "feat/trunk-done",
      "-m",
      "merge done",
    ]);
    const registry = trackRegistry(
      openLinkSandboxRegistry({
        path: registryPathForDataDir(dataDir),
        managedSandboxRoot: join(dataDir, "sandboxes"),
      }),
    );
    registry.upsert({
      handle: "trunk-done",
      status: "stopped",
      sandboxPath,
      port: null,
      previewUrl: null,
      repoCloneUrl: null,
      branch: "feat/trunk-done",
      projectName: "studio",
      error: null,
    });

    const result = registry.prune({ missing: false, merged: true });

    expect(result.removed).toEqual([
      expect.objectContaining({
        handle: "trunk-done",
        reason: "merged",
        deletedFiles: true,
      }),
    ]);
    expect(result.skipped).toEqual([]);
    expect(registry.list()).toEqual([]);
    expect(existsSync(sandboxPath)).toBe(false);
  });

  it("does not treat the checked-out non-default branch as the default branch", async () => {
    const dataDir = tempDir();
    const sandboxPath = join(dataDir, "sandboxes", "worktree-head");
    await initRepo(sandboxPath);
    await runGit(sandboxPath, ["checkout", "-b", "feat/head-risk"]);
    writeFileSync(join(sandboxPath, "feature.txt"), "feature\n");
    await runGit(sandboxPath, ["add", "feature.txt"]);
    await runGit(sandboxPath, ["commit", "-m", "feature"]);
    await runGit(sandboxPath, ["checkout", "main"]);
    await runGit(sandboxPath, ["checkout", "-b", "work"]);
    await runGit(sandboxPath, [
      "merge",
      "--no-ff",
      "feat/head-risk",
      "-m",
      "merge into work only",
    ]);
    const registry = trackRegistry(
      openLinkSandboxRegistry({
        path: registryPathForDataDir(dataDir),
        managedSandboxRoot: join(dataDir, "sandboxes"),
      }),
    );
    registry.upsert({
      handle: "worktree-head",
      status: "stopped",
      sandboxPath,
      port: null,
      previewUrl: null,
      repoCloneUrl: null,
      branch: "feat/head-risk",
      projectName: "studio",
      error: null,
    });

    const result = registry.prune({ missing: false, merged: true });

    expect(result.removed).toEqual([]);
    expect(result.skipped).toEqual([
      expect.objectContaining({
        handle: "worktree-head",
        reason: "branch_not_merged",
        deletedFiles: false,
      }),
    ]);
    expect(registry.list()).toEqual([
      expect.objectContaining({ handle: "worktree-head" }),
    ]);
    expect(existsSync(sandboxPath)).toBe(true);
  });

  it("does not prune a branch merged only into a non-default default-like branch", async () => {
    const dataDir = tempDir();
    const sandboxPath = join(dataDir, "sandboxes", "develop-only");
    await initRepo(sandboxPath);
    await runGit(sandboxPath, ["checkout", "-b", "develop"]);
    await runGit(sandboxPath, ["checkout", "-b", "feat/develop-only"]);
    writeFileSync(join(sandboxPath, "feature.txt"), "feature\n");
    await runGit(sandboxPath, ["add", "feature.txt"]);
    await runGit(sandboxPath, ["commit", "-m", "feature"]);
    await runGit(sandboxPath, ["checkout", "develop"]);
    await runGit(sandboxPath, [
      "merge",
      "--no-ff",
      "feat/develop-only",
      "-m",
      "merge into develop only",
    ]);
    const registry = trackRegistry(
      openLinkSandboxRegistry({
        path: registryPathForDataDir(dataDir),
        managedSandboxRoot: join(dataDir, "sandboxes"),
      }),
    );
    registry.upsert({
      handle: "develop-only",
      status: "stopped",
      sandboxPath,
      port: null,
      previewUrl: null,
      repoCloneUrl: null,
      branch: "feat/develop-only",
      projectName: "studio",
      error: null,
    });

    const result = registry.prune({ missing: false, merged: true });

    expect(result.removed).toEqual([]);
    expect(result.skipped).toEqual([
      expect.objectContaining({
        handle: "develop-only",
        reason: "branch_not_merged",
        deletedFiles: false,
      }),
    ]);
    expect(registry.list()).toEqual([
      expect.objectContaining({ handle: "develop-only" }),
    ]);
    expect(existsSync(sandboxPath)).toBe(true);
  });

  it("skips pruning sandbox directories with dirty worktrees", async () => {
    const dataDir = tempDir();
    const sandboxPath = join(dataDir, "sandboxes", "dirty");
    await initRepo(sandboxPath);
    await runGit(sandboxPath, ["checkout", "-b", "feat/dirty"]);
    writeFileSync(join(sandboxPath, "feature.txt"), "dirty\n");
    await runGit(sandboxPath, ["add", "feature.txt"]);
    await runGit(sandboxPath, ["commit", "-m", "dirty feature"]);
    await runGit(sandboxPath, ["checkout", "main"]);
    await runGit(sandboxPath, [
      "merge",
      "--no-ff",
      "feat/dirty",
      "-m",
      "merge dirty",
    ]);
    writeFileSync(join(sandboxPath, "uncommitted.txt"), "uncommitted\n");
    const registry = trackRegistry(
      openLinkSandboxRegistry({
        path: registryPathForDataDir(dataDir),
        managedSandboxRoot: join(dataDir, "sandboxes"),
      }),
    );
    registry.upsert({
      handle: "dirty",
      status: "stopped",
      sandboxPath,
      port: null,
      previewUrl: null,
      repoCloneUrl: null,
      branch: "feat/dirty",
      projectName: "studio",
      error: null,
    });

    const result = registry.prune({ missing: false, merged: true });

    expect(result.removed).toEqual([]);
    expect(result.skipped).toEqual([
      expect.objectContaining({
        handle: "dirty",
        reason: "dirty_worktree",
        deletedFiles: false,
      }),
    ]);
    expect(registry.list()).toEqual([
      expect.objectContaining({ handle: "dirty" }),
    ]);
    expect(existsSync(sandboxPath)).toBe(true);
  });
});

describe("delete", () => {
  it("removes a single row", () => {
    const registry = openRegistry(registryPathForDataDir(tempDir()));
    registry.upsert({
      handle: "h1",
      status: "stopped",
      sandboxPath: "/tmp/h1",
    });
    registry.upsert({
      handle: "h2",
      status: "stopped",
      sandboxPath: "/tmp/h2",
    });

    registry.delete("h1");

    expect(registry.list().map((r) => r.handle)).toEqual(["h2"]);
  });
});

describe("inspect", () => {
  it("returns null for an unknown handle", () => {
    const registry = openRegistry(registryPathForDataDir(tempDir()));
    expect(registry.inspect("nope")).toBeNull();
  });

  it("reports dirty count and merged=false for an unmerged dirty worktree", async () => {
    const dataDir = tempDir();
    const work = join(dataDir, "sandboxes", "h1");
    await initRepo(work, "main");
    await runGit(work, ["checkout", "-b", "feature"]);
    writeFileSync(join(work, "b.txt"), "2");
    await runGit(work, ["add", "."]);
    await runGit(work, ["commit", "-m", "feat"]);
    writeFileSync(join(work, "c.txt"), "uncommitted"); // 1 dirty file

    const registry = openRegistry(registryPathForDataDir(dataDir));
    registry.upsert({
      handle: "h1",
      status: "ready",
      sandboxPath: work,
      branch: "feature",
    });

    const info = registry.inspect("h1");
    expect(info?.branch).toBe("feature");
    expect(info?.sandboxPath).toBe(work);
    expect(info?.dirtyCount).toBe(1);
    expect(info?.merged).toBe(false);
  });
});
