/**
 * Daemon conformance suite — EXTRA MONOREPO APPS.
 *
 * `application.apps` runs a dev server per extra app beside the main one, and
 * the proxy routes a request to the app its host (or X-Sandbox-App) names.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
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

// Binds a random port and announces it, so the test also covers port sniffing.
const serve = (body: string) =>
  `node -e "const s=require('http').createServer((_q,r)=>{r.setHeader('content-type','text/html');r.end('<html><body>${body}</body></html>')});s.listen(0,()=>console.log('Listening on http://localhost:'+s.address().port+'/'))"`;

const appPackage = (dev: string) =>
  JSON.stringify({ name: "admin", private: true, scripts: { dev } });

async function bodyFor(
  d: Daemon,
  headers: Record<string, string>,
  want: string,
  deadlineMs = 20_000,
): Promise<string> {
  const deadline = Date.now() + deadlineMs;
  let last = "";
  while (Date.now() < deadline) {
    const res = await fetch(url(d, "/"), {
      headers: { accept: "text/html", ...headers },
    });
    last = await res.text();
    if (last.includes(want)) return last;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`never served "${want}"; last body: ${last.slice(0, 300)}`);
}

describe("daemon e2e: extra monorepo apps", () => {
  let d: Daemon;
  let repo: BareRepo;
  let devPort: number;

  const bootstrap = (apps: { path: string }[]) =>
    bootstrapRepo(d, repo.url, {
      application: { packageManager: { name: "npm" }, port: devPort, apps },
      env: { npm_config_offline: "true", PORT: String(devPort) },
    });

  beforeEach(async () => {
    devPort = await freePort();
    d = await startDaemon();
  }, HOOK_TIMEOUT_MS);

  afterEach(async () => {
    await stopDaemon(d);
    repo.cleanup();
  }, HOOK_TIMEOUT_MS);

  it(
    "serves each app at its own host and stops one removed from the config",
    async () => {
      repo = setupBareRepo({
        withPackageJson: true,
        scripts: {
          dev: `node -e "require('http').createServer((_q,s)=>{s.setHeader('content-type','text/html');s.end('<html><body>main-app</body></html>')}).listen(process.env.PORT)"`,
        },
        files: { "apps/admin/package.json": appPackage(serve("admin-app")) },
      });
      expect((await bootstrap([{ path: "apps/admin" }])).status).toBe(200);
      await waitForOrchestratorIdle(d, SETUP_TIMEOUT_MS);

      await bodyFor(d, {}, "main-app");
      await bodyFor(d, { "x-sandbox-app": "apps-admin" }, "admin-app");
      await bodyFor(
        d,
        { host: "thread-abc--apps-admin.localhost" },
        "admin-app",
      );

      expect((await postConfig(d, { application: { apps: [] } })).status).toBe(
        200,
      );
      await bodyFor(d, { "x-sandbox-app": "apps-admin" }, "main-app");
    },
    SETUP_TIMEOUT_MS,
  );

  it(
    "explains an app that cannot run instead of serving the main app",
    async () => {
      repo = setupBareRepo({
        withPackageJson: true,
        scripts: {
          dev: `node -e "require('http').createServer().listen(process.env.PORT)"`,
        },
        files: {
          "apps/admin/package.json": appPackage(
            `node -e "console.error('admin-boom');process.exit(3)"`,
          ),
          "apps/empty/package.json": JSON.stringify({ name: "empty" }),
        },
      });
      expect(
        (await bootstrap([{ path: "apps/admin" }, { path: "apps/empty" }]))
          .status,
      ).toBe(200);
      await waitForOrchestratorIdle(d, SETUP_TIMEOUT_MS);

      const crashed = await bodyFor(
        d,
        { "x-sandbox-app": "apps-admin" },
        "exited with code 3",
      );
      expect(crashed).toContain("admin-boom");
      await bodyFor(
        d,
        { "x-sandbox-app": "apps-empty" },
        "no dev or start script in apps/empty",
      );
    },
    SETUP_TIMEOUT_MS,
  );

  it("rejects an app path outside the repo", async () => {
    const res = await postConfig(d, {
      application: { apps: [{ path: "../escape" }] },
    });
    expect(res.status).toBe(400);
    repo = setupBareRepo();
  });
});
