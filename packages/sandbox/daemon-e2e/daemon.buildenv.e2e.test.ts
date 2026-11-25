/**
 * Daemon conformance suite — BUILD ENV.
 *
 * `buildEnv` reaches the steps that fetch code (git clone, dependency install)
 * and nothing after them: the dev server runs on `env` alone. It is a secret
 * bag, so `/config` never echoes it.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
  authHeaders,
  type BareRepo,
  bootstrapRepo,
  type Daemon,
  freePort,
  HOOK_TIMEOUT_MS,
  postConfig,
  setupBareRepo,
  startDaemon,
  stopDaemon,
  url,
  waitForOrchestratorIdle,
} from "./daemon.e2e.helpers";

const SETUP_TIMEOUT_MS = 60_000;

// Each step records what it was handed, beside the checkout rather than in it.
const record = (file: string) =>
  `require('fs').writeFileSync('../${file}', [process.env.BUILD_ONLY, process.env.RUNTIME_ONLY].join('|'))`;

async function waitForFile(path: string, deadlineMs = 20_000): Promise<string> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return readFileSync(path, "utf8");
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${path} was never written`);
}

describe("daemon e2e: build env", () => {
  let d: Daemon;
  let repo: BareRepo | null = null;

  beforeEach(async () => {
    d = await startDaemon();
  }, HOOK_TIMEOUT_MS);

  afterEach(async () => {
    await stopDaemon(d);
    repo?.cleanup();
    repo = null;
  }, HOOK_TIMEOUT_MS);

  it(
    "reaches clone and install, and never the dev server",
    async () => {
      const devPort = await freePort();
      repo = setupBareRepo({
        withPackageJson: true,
        scripts: {
          preinstall: `node -e "${record("install-env.txt")}"`,
          dev: `node -e "${record("dev-env.txt")};require('http').createServer((_q,s)=>s.end('ok')).listen(process.env.PORT)"`,
        },
      });
      // git appends its trace to an absolute GIT_TRACE path: a file only a git
      // process that was handed the build env can have written.
      const gitTrace = join(d.appDir, "git-trace.log");

      const res = await bootstrapRepo(d, repo.url, {
        application: { packageManager: { name: "npm" }, port: devPort },
        env: {
          npm_config_offline: "true",
          PORT: String(devPort),
          RUNTIME_ONLY: "runtime-value",
        },
        buildEnv: { BUILD_ONLY: "build-value", GIT_TRACE: gitTrace },
      });
      expect(res.status).toBe(200);
      await waitForOrchestratorIdle(d, SETUP_TIMEOUT_MS);

      expect(readFileSync(gitTrace, "utf8")).toContain("clone");
      expect(await waitForFile(join(d.appDir, "install-env.txt"))).toBe(
        "build-value|runtime-value",
      );
      expect(await waitForFile(join(d.appDir, "dev-env.txt"))).toBe(
        "|runtime-value",
      );
    },
    SETUP_TIMEOUT_MS,
  );

  it("is never echoed by /config", async () => {
    // A build-env-only patch on an unclaimed daemon is not persisted; claim it
    // first so there is a stored build env for the responses to leak.
    expect((await postConfig(d, { env: { CLAIMED: "1" } })).status).toBe(200);

    const put = await postConfig(d, {
      buildEnv: { NPM_TOKEN: "npm_supersecret", OLD: "x" },
    });
    expect(put.status).toBe(200);
    expect(await put.text()).not.toContain("npm_supersecret");

    const replaced = await postConfig(d, { buildEnv: { NPM_TOKEN: "next" } });
    expect(replaced.status).toBe(200);

    const get = await fetch(url(d, "/_sandbox/config"), {
      headers: authHeaders(),
    });
    const body = await get.text();
    expect(body).toContain("CLAIMED");
    expect(body).not.toContain("NPM_TOKEN");
    expect(body).not.toContain("buildEnv");
  });

  it("rejects an invalid key", async () => {
    const res = await postConfig(d, { buildEnv: { "not a key": "x" } });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("buildEnv: env key invalid");
  });
});
