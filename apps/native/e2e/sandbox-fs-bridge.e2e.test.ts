/**
 * Black-box contract for the production Blocks editor's native filesystem
 * bridge.
 *
 * The shared web UI intentionally keeps using its existing mesh-shaped route:
 *
 *   POST /api/:org/sandbox/:virtualMcpId/:branch/{write,read,unlink}
 *
 * In the native app, local-api must intercept that family before the upstream
 * proxy and route it to the exact durable Rust sandbox identified by
 * `(virtualMcpId, branch)`. This suite drives the real binary and real git
 * worktrees. It deliberately keeps sandbox B active while mutating sandbox A:
 * following the active sandbox here would turn a debounced Blocks autosave
 * into silent cross-chat data corruption.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sleep } from "@decocms/shared/std";
import { afterAll, beforeAll, expect, it } from "bun:test";
import { computeHandle, normalizeBranch, repoDirFor } from "./sandbox-handle";

import {
  signInAndCompleteSession,
  startAuthenticatedUpstream,
} from "./authenticated-upstream";

import {
  describeLocalApi,
  HOOK_TIMEOUT_MS,
  jsonAuthHeaders,
  startLocalApi,
  stopLocalApi,
  url,
  type LocalApi,
} from "./helpers";

const ORG = "blocks-native-e2e";
const VIRTUAL_MCP_ID = "blocks/vmcp/with-slashes";
const FEATURE_BRANCH = "feature/blocks/save";
const OTHER_BRANCH = "main";
const THREAD_ID = "sandbox-authority-thread";
const THREAD_VIRTUAL_MCP_ID = "sandbox-authority-vmcp";
const THREAD_BRANCH = `thread:${THREAD_ID}`;

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} (cwd=${cwd}) failed: ${
        result.stderr || result.stdout
      }`,
    );
  }
}

function setupFixtureRepo(): { root: string; bareDir: string } {
  const root = mkdtempSync(join(tmpdir(), "sandbox-fs-bridge-e2e-"));
  const bareDir = join(root, "origin.git");
  const workDir = join(root, "author");

  git(root, ["init", "--bare", "-q", bareDir]);
  git(root, ["init", "-q", "-b", "main", workDir]);
  git(workDir, ["config", "user.name", "Test User"]);
  git(workDir, ["config", "user.email", "test@example.com"]);
  writeFileSync(
    join(workDir, "package.json"),
    JSON.stringify({
      name: "sandbox-fs-bridge-fixture",
      private: true,
      scripts: {},
    }),
  );
  writeFileSync(join(workDir, "BRANCH.txt"), "main\n");
  git(workDir, ["add", "."]);
  git(workDir, ["commit", "-q", "-m", "initial"]);
  git(workDir, ["remote", "add", "origin", bareDir]);
  git(workDir, ["push", "-q", "-u", "origin", "main"]);
  git(bareDir, ["symbolic-ref", "HEAD", "refs/heads/main"]);

  git(workDir, ["checkout", "-q", "-b", FEATURE_BRANCH]);
  writeFileSync(join(workDir, "BRANCH.txt"), "feature\n");
  git(workDir, ["commit", "-q", "-am", "feature branch"]);
  git(workDir, ["push", "-q", "-u", "origin", FEATURE_BRANCH]);

  return { root, bareDir };
}

function sandboxRoute(
  a: LocalApi,
  virtualMcpId: string,
  branch: string,
  operation: "read" | "write" | "unlink",
): string {
  return url(
    a,
    `/api/${ORG}/sandbox/${encodeURIComponent(
      virtualMcpId,
    )}/${encodeURIComponent(branch)}/${operation}`,
  );
}

async function ensureSandbox(
  a: LocalApi,
  cloneUrl: string,
  branch: string,
  virtualMcpId = VIRTUAL_MCP_ID,
): Promise<string> {
  const response = await fetch(url(a, "/_sandbox/setup/ensure"), {
    method: "POST",
    headers: jsonAuthHeaders(),
    body: JSON.stringify({
      virtualMcpId,
      repo: { cloneUrl, branch },
      workload: { runtime: "bun", packageManager: "bun" },
    }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { handle?: string };
  expect(body.handle).toBe(computeHandle(cloneUrl, normalizeBranch(branch)));
  return body.handle!;
}

async function waitForFile(
  path: string,
  expected: string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path) && readFileSync(path, "utf8") === expected) return;
    await sleep(100);
  }
  throw new Error(
    `file ${path} did not contain ${JSON.stringify(expected)} within ${timeoutMs}ms`,
  );
}

async function writeSandboxFile(
  a: LocalApi,
  branch: string,
  path: string,
  content: string,
  virtualMcpId = VIRTUAL_MCP_ID,
): Promise<Response> {
  return fetch(sandboxRoute(a, virtualMcpId, branch, "write"), {
    method: "POST",
    headers: jsonAuthHeaders(),
    body: JSON.stringify({ path, content }),
  });
}

async function readSandboxFile(
  a: LocalApi,
  branch: string,
  path: string,
  virtualMcpId = VIRTUAL_MCP_ID,
): Promise<Response> {
  return fetch(sandboxRoute(a, virtualMcpId, branch, "read"), {
    method: "POST",
    headers: jsonAuthHeaders(),
    body: JSON.stringify({ path, full: true }),
  });
}

describeLocalApi(
  "local-api e2e: Blocks editor native sandbox filesystem bridge",
  () => {
    let a: LocalApi;
    let upstream: ReturnType<typeof startAuthenticatedUpstream>;
    let fixture: { root: string; bareDir: string };
    let appRoot: string;
    let featureHandle: string;
    let otherHandle: string;
    let featureRepo: string;
    let otherRepo: string;

    beforeAll(async () => {
      fixture = setupFixtureRepo();
      upstream = startAuthenticatedUpstream();
      a = await startLocalApi({
        DECOCMS_UPSTREAM_URL: upstream.url,
        LOCAL_API_TOKEN_STORE: "memory",
      });
      await signInAndCompleteSession(a);
      appRoot = a.workdir;

      featureHandle = await ensureSandbox(a, fixture.bareDir, FEATURE_BRANCH);
      featureRepo = repoDirFor(appRoot, featureHandle);
      await waitForFile(join(featureRepo, "BRANCH.txt"), "feature\n");

      // Ensure this one LAST so it remains the active sandbox. Every request
      // below that names FEATURE_BRANCH must nevertheless resolve the feature
      // sandbox from its URL identity.
      otherHandle = await ensureSandbox(a, fixture.bareDir, OTHER_BRANCH);
      otherRepo = repoDirFor(appRoot, otherHandle);
      await waitForFile(join(otherRepo, "BRANCH.txt"), "main\n");

      const created = await fetch(
        url(a, `/api/${ORG}/tools/COLLECTION_THREADS_CREATE`),
        {
          method: "POST",
          headers: jsonAuthHeaders(),
          body: JSON.stringify({
            data: {
              id: THREAD_ID,
              title: "Sandbox authority",
              virtual_mcp_id: THREAD_VIRTUAL_MCP_ID,
            },
          }),
        },
      );
      expect(created.status).toBe(200);
      const threadHandle = await ensureSandbox(
        a,
        fixture.bareDir,
        THREAD_BRANCH,
        THREAD_VIRTUAL_MCP_ID,
      );
      await waitForFile(
        join(repoDirFor(appRoot, threadHandle), "BRANCH.txt"),
        "main\n",
      );
    }, HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await stopLocalApi(a, { keepWorkdir: true });
      upstream.server.stop(true);
      rmSync(appRoot, { recursive: true, force: true });
      rmSync(fixture.root, { recursive: true, force: true });
    }, HOOK_TIMEOUT_MS);

    it("requires a signed-in Studio account in addition to the loopback bearer", async () => {
      const signedOut = await startLocalApi({
        DECOCMS_UPSTREAM_URL: upstream.url,
        LOCAL_API_TOKEN_STORE: "memory",
      });
      try {
        const response = await writeSandboxFile(
          signedOut,
          FEATURE_BRANCH,
          "must-not-write.json",
          "{}",
        );
        expect(response.status).toBe(401);
      } finally {
        await stopLocalApi(signedOut);
      }
    });

    it("lets an owner mutate its active thread workspace, rejects a virtual MCP mismatch, and leaves archived workspaces read-only", async () => {
      const path = "thread-authority.json";
      const write = await writeSandboxFile(
        a,
        THREAD_BRANCH,
        path,
        '{"owner":true}',
        THREAD_VIRTUAL_MCP_ID,
      );
      const writeBody = await write.json();
      expect({ status: write.status, body: writeBody }).toMatchObject({
        status: 200,
        body: { ok: true },
      });

      const mismatchedVirtualMcp = await writeSandboxFile(
        a,
        THREAD_BRANCH,
        "mismatched-virtual-mcp.json",
        "{}",
        "different-vmcp",
      );
      expect(mismatchedVirtualMcp.status).toBe(404);

      const archived = await fetch(
        url(a, `/api/${ORG}/tools/COLLECTION_THREADS_UPDATE`),
        {
          method: "POST",
          headers: jsonAuthHeaders(),
          body: JSON.stringify({ id: THREAD_ID, data: { hidden: true } }),
        },
      );
      expect(archived.status).toBe(200);

      const archivedWrite = await writeSandboxFile(
        a,
        THREAD_BRANCH,
        "archived-write.json",
        "{}",
        THREAD_VIRTUAL_MCP_ID,
      );
      expect(archivedWrite.status).toBe(409);

      const archivedRead = await readSandboxFile(
        a,
        THREAD_BRANCH,
        path,
        THREAD_VIRTUAL_MCP_ID,
      );
      expect(archivedRead.status).toBe(200);
      expect(await archivedRead.json()).toMatchObject({
        kind: "text",
        content: '1\t{"owner":true}',
        lineCount: 1,
      });
    });

    it("URL-decodes virtualMcpId + branch and never follows the other active sandbox", async () => {
      const path = ".deco/blocks/identity.json";
      const featureFile = join(featureRepo, path);
      const otherFile = join(otherRepo, path);

      const response = await writeSandboxFile(
        a,
        FEATURE_BRANCH,
        path,
        '{"sandbox":"feature"}',
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ok: true,
        bytesWritten: 21,
      });

      expect(readFileSync(featureFile, "utf8")).toBe('{"sandbox":"feature"}');
      expect(existsSync(otherFile)).toBe(false);

      const read = await readSandboxFile(a, FEATURE_BRANCH, path);
      expect(read.status).toBe(200);
      const body = (await read.json()) as { kind: string; content: string };
      expect(body.kind).toBe("text");
      expect(body.content).toContain('{"sandbox":"feature"}');
    });

    it("clamps relative paths to the URL-selected sandbox instead of permitting sibling-worktree traversal", async () => {
      const escapedTarget = join(otherRepo, "cross-sandbox-write.txt");
      const response = await writeSandboxFile(
        a,
        FEATURE_BRANCH,
        `../../${otherHandle}/repo/cross-sandbox-write.txt`,
        "must not land in main",
      );
      expect(response.status).toBe(400);
      expect(existsSync(escapedTarget)).toBe(false);
    });

    it("rejects absolute-path reads on the org-scoped bridge even when the file exists", async () => {
      const response = await readSandboxFile(
        a,
        FEATURE_BRANCH,
        join(otherRepo, "BRANCH.txt"),
      );
      expect(response.status).toBe(400);
    });

    it("completes the Blocks write -> read -> unlink lifecycle in one sandbox", async () => {
      const path = ".deco/blocks/lifecycle.json";
      const file = join(featureRepo, path);
      const content = JSON.stringify({ title: "Edited in Blocks" }, null, 2);

      const write = await writeSandboxFile(a, FEATURE_BRANCH, path, content);
      expect(write.status).toBe(200);
      expect(readFileSync(file, "utf8")).toBe(content);

      const read = await readSandboxFile(a, FEATURE_BRANCH, path);
      expect(read.status).toBe(200);
      const readBody = (await read.json()) as { content: string };
      expect(readBody.content).toContain('"title": "Edited in Blocks"');

      const unlink = await fetch(
        sandboxRoute(a, VIRTUAL_MCP_ID, FEATURE_BRANCH, "unlink"),
        {
          method: "POST",
          headers: jsonAuthHeaders(),
          body: JSON.stringify({ path }),
        },
      );
      expect(unlink.status).toBe(200);
      expect(await unlink.json()).toMatchObject({ ok: true, existed: true });
      expect(existsSync(file)).toBe(false);

      const afterDelete = await readSandboxFile(a, FEATURE_BRANCH, path);
      expect(afterDelete.status).toBe(400);
      expect(await afterDelete.json()).toEqual({
        error: `File not found: ${path}`,
      });
    });

    it("returns a local 404 for an unregistered URL identity instead of forwarding upstream", async () => {
      const response = await writeSandboxFile(
        a,
        FEATURE_BRANCH,
        ".deco/blocks/unknown.json",
        "{}",
        "unknown/vmcp",
      );
      expect(response.status).toBe(404);
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain("sandbox not found");
    });

    it("resolves the exact SQLite-registered sandbox after a local-api process restart", async () => {
      const path = ".deco/blocks/persisted.json";
      const file = join(featureRepo, path);
      const beforeRestart = '{"generation":1}';
      const afterRestart = '{"generation":2}';

      const initialWrite = await writeSandboxFile(
        a,
        FEATURE_BRANCH,
        path,
        beforeRestart,
      );
      expect(initialWrite.status).toBe(200);
      expect(readFileSync(file, "utf8")).toBe(beforeRestart);

      await stopLocalApi(a, { keepWorkdir: true });
      a = await startLocalApi(
        {
          DECOCMS_UPSTREAM_URL: upstream.url,
          LOCAL_API_TOKEN_STORE: "memory",
        },
        { workdir: appRoot },
      );
      await signInAndCompleteSession(a);

      // No setup/ensure call after relaunch: this request must recover the
      // explicit URL identity from the registry (studio.db). The persisted active
      // pointer still names OTHER_BRANCH, so active fallback would fail this.
      const persistedRead = await readSandboxFile(a, FEATURE_BRANCH, path);
      expect(persistedRead.status).toBe(200);
      const persistedBody = (await persistedRead.json()) as {
        content: string;
      };
      expect(persistedBody.content).toContain(beforeRestart);

      const subsequentWrite = await writeSandboxFile(
        a,
        FEATURE_BRANCH,
        path,
        afterRestart,
      );
      expect(subsequentWrite.status).toBe(200);
      expect(readFileSync(file, "utf8")).toBe(afterRestart);
      expect(existsSync(join(otherRepo, path))).toBe(false);
    });
  },
);
