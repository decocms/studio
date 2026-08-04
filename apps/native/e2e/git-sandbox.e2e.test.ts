/**
 * Black-box verification for the PER-HANDLE git sandbox (see
 * the native Git-sandbox contract): "one working directory per
 * branch" + a working dev-server preview through the reverse proxy.
 *
 * Drives the REAL `local-api` binary (via `LOCAL_API_E2E_CMD`, see
 * `helpers.ts`) against a REAL local `file://`-style bare-repo git fixture
 * (no network) with a `package.json` whose `dev` script binds an ephemeral
 * port and prints a `Local: http://localhost:PORT` line — the exact
 * announcement `setup/dev.rs`'s port-sniffer regex matches — mirroring the
 * daemon e2e suite's own git fixture conventions
 * (`packages/sandbox/daemon-e2e/daemon.git.e2e.test.ts`).
 *
 * Proves, over HTTP only (no Rust-internal access):
 *   (a) ensuring branch A clones the fixture repo into
 *       `<APP_ROOT>/sandboxes/<handleA>/repo`, checked out to branch A, and
 *       a file written through the sandbox bridge lands in THAT directory;
 *   (b) ensuring branch B (same repo) produces a SECOND, independent
 *       clone at `<handleB>` on branch B — branch A's directory/files are
 *       untouched;
 *   (c) each branch's `dev` script runs in ITS OWN workdir, the port is
 *       sniffed from stdout (not statically configured), and a preview
 *       request THROUGH THE DEDICATED PREVIEW LISTENER (`a.previewPort`,
 *       `routes/proxy.rs`'s reverse proxy — a genuinely separate loopback
 *       port from the app's own API port, see `local_api::ServerHandle`'s
 *       doc comment) — routed by the `x-decocms-sandbox-handle` header —
 *       returns that branch's actual dev-server response body, not the "No
 *       dev server"/"Starting" placeholder.
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
import {
  computeHandle,
  repoDirFor,
  type SandboxAccountPathScope,
} from "./sandbox-handle";

import {
  signInAndCompleteSession,
  startAuthenticatedUpstream,
} from "./authenticated-upstream";

import {
  describeLocalApi,
  HOOK_TIMEOUT_MS,
  jsonAuthHeaders,
  previewUrl,
  startLocalApi,
  stopLocalApi,
  type LocalApi,
  url,
} from "./helpers";

function git(cwd: string, args: string[]): void {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} (cwd=${cwd}) failed: ${res.stderr || res.stdout}`,
    );
  }
}

const SERVER_JS = `
const http = require("http");
const fs = require("fs");
const path = require("path");
const branch = fs.readFileSync(path.join(__dirname, "BRANCH.txt"), "utf8").trim();
const server = http.createServer((req, res) => {
  // text/html (not text/plain): the reverse proxy's own module doc
  // (\`routes/proxy.rs\`) renders a dedicated "No web page at this URL"
  // notice for a non-HTML root response instead of passing it through —
  // this fixture needs its real body to reach the test unmodified.
  res.setHeader("content-type", "text/html");
  res.end("<html><body>hello from branch: " + branch + "</body></html>");
});
server.listen(0, "127.0.0.1", () => {
  const addr = server.address();
  console.log("Local: http://localhost:" + addr.port + "/");
});
`;

const PACKAGE_JSON = JSON.stringify({
  name: "git-sandbox-fixture",
  private: true,
  scripts: { dev: "node server.js" },
});
const ORG = "git-sandbox-e2e";
const AUTHENTICATED_ACCOUNT_SUB = "sandbox-e2e-user";

/** Builds a bare "origin" with two branches (`branch-a`, `branch-b`), each
 * carrying a distinguishing `BRANCH.txt` + a real bindable dev server —
 * returns the bare repo's filesystem path (used directly as `cloneUrl`,
 * exactly like a `file://` remote). */
function setupFixtureRepo(): { root: string; bareDir: string } {
  const root = mkdtempSync(join(tmpdir(), "git-sandbox-e2e-"));
  const bareDir = join(root, "origin.git");
  const workDir = join(root, "author");
  git(root, ["init", "--bare", "-q", bareDir]);
  git(root, ["init", "-q", "-b", "main", workDir]);
  git(workDir, ["config", "user.name", "Test User"]);
  git(workDir, ["config", "user.email", "test@example.com"]);
  writeFileSync(join(workDir, "package.json"), PACKAGE_JSON);
  writeFileSync(join(workDir, "server.js"), SERVER_JS);
  writeFileSync(join(workDir, "BRANCH.txt"), "main\n");
  git(workDir, ["add", "."]);
  git(workDir, ["commit", "-q", "-m", "initial"]);
  git(workDir, ["remote", "add", "origin", bareDir]);
  git(workDir, ["push", "-q", "-u", "origin", "main"]);
  git(bareDir, ["symbolic-ref", "HEAD", "refs/heads/main"]);

  git(workDir, ["checkout", "-q", "-b", "branch-a"]);
  writeFileSync(join(workDir, "BRANCH.txt"), "A\n");
  git(workDir, ["commit", "-q", "-am", "branch A"]);
  git(workDir, ["push", "-q", "-u", "origin", "branch-a"]);

  git(workDir, ["checkout", "-q", "main"]);
  git(workDir, ["checkout", "-q", "-b", "branch-b"]);
  writeFileSync(join(workDir, "BRANCH.txt"), "B\n");
  git(workDir, ["commit", "-q", "-am", "branch B"]);
  git(workDir, ["push", "-q", "-u", "origin", "branch-b"]);

  return { root, bareDir };
}

async function ensureAndWriteSandboxFile(
  a: LocalApi,
  account: SandboxAccountPathScope,
  virtualMcpId: string,
  cloneUrl: string,
  branch: string,
): Promise<void> {
  const ensure = await fetch(url(a, "/_sandbox/setup/ensure"), {
    method: "POST",
    headers: jsonAuthHeaders(),
    body: JSON.stringify({
      virtualMcpId,
      repo: { cloneUrl, branch },
      workload: { runtime: "bun", packageManager: "bun" },
    }),
  });
  expect(ensure.status).toBe(200);
  const expectedHandle = computeHandle(cloneUrl, branch);
  const ensured = (await ensure.json()) as { handle: string };
  expect(ensured.handle).toBe(expectedHandle);

  // setup/ensure admits the asynchronous clone/install/start cascade. Wait
  // for this handle's real preview (not its starting placeholder) before
  // writing into or asserting on the materialized checkout.
  await waitForPreviewBody(a, expectedHandle);

  const repoDir = repoDirFor(a.workdir, expectedHandle, account);
  const write = await fetch(
    url(
      a,
      `/api/${ORG}/sandbox/${encodeURIComponent(
        virtualMcpId,
      )}/${encodeURIComponent(branch)}/write`,
    ),
    {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: JSON.stringify({
        path: "bridge-wrote.txt",
        content: `written through sandbox bridge in ${repoDir}\n`,
      }),
    },
  );
  expect(write.status).toBe(200);
}

/** Polls the PREVIEW listener's reverse-proxy fallback (its ONLY route,
 * UNauthenticated — see `router.rs`'s `build_preview` doc comment) with the
 * per-handle routing header until it stops serving the "No dev
 * server"/"Starting" placeholder and returns the dev server's real body. */
async function waitForPreviewBody(
  a: LocalApi,
  handle: string,
  deadlineMs = 45_000,
): Promise<string> {
  const deadline = Date.now() + deadlineMs;
  let lastText = "";
  while (Date.now() < deadline) {
    const res = await fetch(previewUrl(a, "/"), {
      headers: { "x-decocms-sandbox-handle": handle },
    });
    lastText = await res.text();
    if (
      res.status === 200 &&
      !lastText.includes("No dev server running") &&
      !lastText.includes("Server is starting")
    ) {
      return lastText;
    }
    await sleep(300);
  }
  throw new Error(
    `preview for handle ${handle} never became ready within ${deadlineMs}ms; last body: ${lastText.slice(0, 300)}`,
  );
}

describeLocalApi(
  "local-api e2e: per-handle git sandbox (one workdir per branch)",
  () => {
    let a: LocalApi;
    let upstream: ReturnType<typeof startAuthenticatedUpstream>;
    let account: SandboxAccountPathScope;
    let fixture: { root: string; bareDir: string };
    const virtualMcpId = "git-sandbox-e2e-vmcp";

    beforeAll(async () => {
      fixture = setupFixtureRepo();
      upstream = startAuthenticatedUpstream();
      account = {
        upstreamUrl: upstream.url,
        accountSub: AUTHENTICATED_ACCOUNT_SUB,
      };
      a = await startLocalApi({ DECOCMS_UPSTREAM_URL: upstream.url });
      await signInAndCompleteSession(a);
    }, HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await stopLocalApi(a);
      upstream.server.stop(true);
      rmSync(fixture.root, { recursive: true, force: true });
    }, HOOK_TIMEOUT_MS);

    it("isolates two branches of the same repo into two independent workdirs, each with its own running (sniffed-port) preview", async () => {
      const handleA = computeHandle(fixture.bareDir, "branch-a");
      const handleB = computeHandle(fixture.bareDir, "branch-b");
      const repoA = repoDirFor(a.workdir, handleA, account);
      const repoB = repoDirFor(a.workdir, handleB, account);

      // (a) Materialize branch A and write through its scoped bridge.
      await ensureAndWriteSandboxFile(
        a,
        account,
        virtualMcpId,
        fixture.bareDir,
        "branch-a",
      );
      expect(existsSync(join(repoA, ".git"))).toBe(true);
      expect(readFileSync(join(repoA, "BRANCH.txt"), "utf8").trim()).toBe("A");
      expect(existsSync(join(repoA, "bridge-wrote.txt"))).toBe(true);
      expect(readFileSync(join(repoA, "bridge-wrote.txt"), "utf8")).toContain(
        repoA,
      );

      // (b) Ensure branch B — same repo, a SECOND independent handle.
      await ensureAndWriteSandboxFile(
        a,
        account,
        virtualMcpId,
        fixture.bareDir,
        "branch-b",
      );
      expect(handleB).not.toBe(handleA);
      expect(existsSync(join(repoB, ".git"))).toBe(true);
      expect(readFileSync(join(repoB, "BRANCH.txt"), "utf8").trim()).toBe("B");
      expect(existsSync(join(repoB, "bridge-wrote.txt"))).toBe(true);
      expect(readFileSync(join(repoB, "bridge-wrote.txt"), "utf8")).toContain(
        repoB,
      );

      // Branch A's directory/files are UNTOUCHED by branch B's sandbox setup —
      // the "one pwd per branch" proof.
      expect(readFileSync(join(repoA, "BRANCH.txt"), "utf8").trim()).toBe("A");
      expect(readFileSync(join(repoA, "bridge-wrote.txt"), "utf8")).toContain(
        repoA,
      );
      expect(
        readFileSync(join(repoA, "bridge-wrote.txt"), "utf8"),
      ).not.toContain(repoB);

      // (c) Each branch's own dev server, reached via the reverse proxy
      // routed by handle — real body, not the placeholder. Different
      // branches ⇒ different (ephemeral, sniffed) ports.
      const bodyA = await waitForPreviewBody(a, handleA);
      const bodyB = await waitForPreviewBody(a, handleB);
      expect(bodyA).toContain("hello from branch: A");
      expect(bodyB).toContain("hello from branch: B");
      expect(bodyA).not.toBe(bodyB);

      // An unrecognized handle must never fall back to either real preview.
      const unknownRes = await fetch(previewUrl(a, "/"), {
        headers: { "x-decocms-sandbox-handle": "not-a-real-handle" },
      });
      expect(unknownRes.status).toBe(503);
      expect(await unknownRes.text()).toContain("No dev server running");
    }, 90_000);
  },
);
