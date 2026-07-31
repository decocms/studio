/**
 * Daemon conformance suite — golden cache publish gate.
 *
 * A golden published from a boot that never came up healthy is reused by every
 * later boot of that lockfile, so the publish is deferred to the dev server's
 * first healthy probe. Asserted on the setup stream, not just an empty store:
 * publish reflinks, which fails on non-CoW filesystems anyway, so the store
 * check alone would pass while the gate was broken. The positive direction needs
 * a CoW filesystem and lives in the implementation's own tests.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type BareRepo,
  bootstrapRepo,
  type Daemon,
  HOOK_TIMEOUT_MS,
  setupBareRepo,
  startDaemon,
  stopDaemon,
  waitForOrchestratorIdle,
} from "./daemon.e2e.helpers";

const SETUP_TIMEOUT_MS = 120_000;

// npm's first-run audit/update checks otherwise wait on the registry for the
// whole hook timeout; the fixture has no real dependencies.
const HERMETIC_NPM = {
  npm_config_audit: "false",
  npm_config_fund: "false",
  npm_config_offline: "true",
  npm_config_update_notifier: "false",
};

let d: Daemon | null = null;
let repo: BareRepo | null = null;
let cacheRoot: string | null = null;

beforeEach(() => {
  cacheRoot = mkdtempSync(join(tmpdir(), "daemon-e2e-deps-cache-"));
  repo = setupBareRepo({ withPackageJson: true });
});

afterEach(async () => {
  await stopDaemon(d);
  d = null;
  repo?.cleanup();
  repo = null;
  if (cacheRoot) rmSync(cacheRoot, { recursive: true, force: true });
  cacheRoot = null;
}, HOOK_TIMEOUT_MS);

/** Golden dirs currently in the store, across every repo partition. */
function publishedGoldens(root: string): string[] {
  const goldenRoot = join(root, "golden");
  if (!existsSync(goldenRoot)) return [];
  return readdirSync(goldenRoot).flatMap((repoHash) => {
    const repoDir = join(goldenRoot, repoHash);
    return readdirSync(repoDir)
      .filter((name) => !name.startsWith(".tmp.")) // an in-flight publish is not published
      .map((name) => join(repoHash, name));
  });
}

describe("daemon e2e: golden cache", () => {
  it(
    "a boot whose dev server never comes up publishes no golden",
    async () => {
      d = await startDaemon({
        GOLDEN_CACHE_ENABLED: "1",
        DEPS_CACHE_ROOT: cacheRoot!,
      });
      const res = await bootstrapRepo(d, repo!.url, {
        application: { packageManager: { name: "npm" } },
        env: HERMETIC_NPM,
      });
      expect(res.status).toBe(200);
      await waitForOrchestratorIdle(d, SETUP_TIMEOUT_MS);

      // Install succeeded; start could not (no dev/start script), so the probe
      // never reported healthy and the publish must not have been attempted.
      expect(d.stdout.value).not.toInclude("[golden]");
      expect(publishedGoldens(cacheRoot!)).toEqual([]);
    },
    SETUP_TIMEOUT_MS,
  );

  it(
    "the cache root is untouched when golden is not enabled",
    async () => {
      d = await startDaemon({ DEPS_CACHE_ROOT: cacheRoot! });
      const res = await bootstrapRepo(d, repo!.url, {
        application: { packageManager: { name: "npm" } },
        env: HERMETIC_NPM,
      });
      expect(res.status).toBe(200);
      await waitForOrchestratorIdle(d, SETUP_TIMEOUT_MS);

      // Golden ships dormant: without its own opt-in the store is never created,
      // even though DEPS_CACHE_ROOT is set.
      expect(existsSync(join(cacheRoot!, "golden"))).toBe(false);
    },
    SETUP_TIMEOUT_MS,
  );
});
