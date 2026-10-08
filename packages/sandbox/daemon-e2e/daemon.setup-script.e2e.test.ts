/**
 * Daemon conformance suite — REPOSITORY SETUP HOOK.
 *
 * A repo may ship `decocms.setup.sh`. The daemon runs it after the checkout
 * and BEFORE the dependency install, with the sandbox's configured env in
 * scope. It exists for credentials a package manager needs before it can
 * resolve anything — a private registry's `.npmrc` is the case that forced it,
 * and no package-manager script can produce one, because resolution of a
 * script's own imports happens before its first line runs.
 *
 * Black-box: the fixture's hook records what it saw (the env var, and whether
 * node_modules existed yet) into a file, which is the only way to assert the
 * ordering from outside the pod.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "bun:test";

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

const EVIDENCE = "setup-evidence.txt";

/** Records both facts the hook guarantees: the env reached it, and no install had run yet. */
const HOOK = `#!/bin/sh
if [ -d node_modules ]; then stage=after-install; else stage=before-install; fi
printf '%s|%s\\n' "$REGISTRY_TOKEN" "$stage" > ${EVIDENCE}
`;

const repoWithHook = (): BareRepo =>
  setupBareRepo({
    withPackageJson: true,
    files: { "decocms.setup.sh": HOOK },
  });

const evidencePath = (d: Daemon) => join(d.appDir, "repo", EVIDENCE);

describe("repository setup hook", () => {
  let d: Daemon | null = null;
  let repo: BareRepo | null = null;

  afterEach(async () => {
    await stopDaemon(d);
    d = null;
    repo?.cleanup();
    repo = null;
  });

  it(
    "runs the hook with the configured env, before the install",
    async () => {
      repo = repoWithHook();
      d = await startDaemon();
      await bootstrapRepo(d, repo.url, {
        repoSetupScript: true,
        application: { packageManager: { name: "npm" } },
        env: {
          REGISTRY_TOKEN: "synthetic-not-a-real-token",
          npm_config_offline: "true",
        },
      });
      await waitForOrchestratorIdle(d, HOOK_TIMEOUT_MS);

      expect(existsSync(evidencePath(d))).toBe(true);
      expect(readFileSync(evidencePath(d), "utf8").trim()).toBe(
        "synthetic-not-a-real-token|before-install",
      );
    },
    HOOK_TIMEOUT_MS,
  );

  it(
    "leaves the boot untouched when the org flag is off",
    async () => {
      repo = repoWithHook();
      d = await startDaemon();
      await bootstrapRepo(d, repo.url, {
        application: { packageManager: { name: "npm" } },
        env: {
          REGISTRY_TOKEN: "synthetic-not-a-real-token",
          npm_config_offline: "true",
        },
      });
      await waitForOrchestratorIdle(d, HOOK_TIMEOUT_MS);

      expect(existsSync(evidencePath(d))).toBe(false);
    },
    HOOK_TIMEOUT_MS,
  );
});
