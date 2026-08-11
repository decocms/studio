/**
 * Daemon conformance suite — GIT SUBMODULES.
 *
 * A repo with private submodules needs a per-host PAT the main clone token
 * can't supply. The daemon takes those credentials on
 * `git.repository.submoduleCredentials` and fetches submodules during the clone
 * step. The feature is opt-in and best-effort: a submodule that can't be fetched
 * must never fail the clone.
 *
 * Black-box: credentials go in over HTTP, and assertions read HTTP responses,
 * the clone-step log artifact, or the working tree. The credentials-file
 * mechanics (0600, deletion) are asserted in the implementation's own tests;
 * what's pinned here is the wire contract — the fetch is attempted with the
 * SSH→HTTPS rewrite applied, the token never comes back out, and a submodule
 * failure leaves the checkout intact.
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
  authHeaders,
  type BareRepo,
  bootstrapRepo,
  type Daemon,
  HOOK_TIMEOUT_MS,
  postConfig,
  setupBareRepo,
  startDaemon,
  stopDaemon,
  url,
  waitForOrchestratorIdle,
} from "./daemon.e2e.helpers";

const SETUP_TIMEOUT_MS = 60_000;
const TOKEN = "ghp_e2e_synthetic_never_real";
// RFC 2606 reserved TLD: resolution fails by spec, so the fetch never leaves the
// machine. It is not instant — a hijacking resolver turns NXDOMAIN into a
// connect attempt — which is why the submodule step runs on a single try rather
// than through the clone's transient-error retry loop.
const HOST = "bff.invalid";
const SUBMODULE_URL = `git@${HOST}:acme/bff.git`;

/**
 * The clone step's log artifact under APP_ROOT. Throws rather than returning ""
 * for a missing file: every assertion below is `not.toContain`, and an empty
 * string satisfies all of them for the wrong reason.
 */
function cloneLog(d: Daemon): string {
  const path = join(d.appDir, "tmp", "app", "clone");
  if (!existsSync(path)) {
    throw new Error(`no clone log at ${path} — the clone step did not run`);
  }
  const body = readFileSync(path, "utf8");
  if (!body.includes("$ git")) {
    throw new Error(`clone log has no git steps in it:\n${body}`);
  }
  return body;
}

/**
 * Commit a `.gitmodules` declaring one submodule on `origin`'s default branch,
 * so a clone of it has submodules to fetch. The gitlink is written by hand
 * (`update-index --cacheinfo`) rather than via `git submodule add`, which would
 * require the submodule remote to be reachable at fixture time.
 */
function addGitmodules(repo: BareRepo): void {
  const seed = join(repo.root, "seed");
  const cfg =
    "-c user.email=test@example.com -c user.name=test -c commit.gpgsign=false";
  writeFileSync(
    join(seed, ".gitmodules"),
    `[submodule "vendor/bff"]\n\tpath = vendor/bff\n\turl = ${SUBMODULE_URL}\n`,
  );
  const o = { stdio: "ignore" as const };
  execSync(`git ${cfg} -C ${seed} add .gitmodules`, o);
  execSync(
    `git ${cfg} -C ${seed} update-index --add --cacheinfo 160000,0000000000000000000000000000000000000001,vendor/bff`,
    o,
  );
  execSync(`git ${cfg} -C ${seed} commit -m submodule`, o);
  execSync(`git ${cfg} -C ${seed} push origin main`, o);
}

const withCreds = (
  cloneUrl: string,
  submoduleCredentials: { host: string; token: string }[],
) => ({ git: { repository: { cloneUrl, submoduleCredentials } } });

describe("daemon e2e: git submodules", () => {
  let d: Daemon;
  let repo: BareRepo;
  beforeEach(async () => {
    d = await startDaemon();
    repo = setupBareRepo();
  }, HOOK_TIMEOUT_MS);
  afterEach(async () => {
    await stopDaemon(d);
    repo?.cleanup();
  }, HOOK_TIMEOUT_MS);

  it(
    "fetches submodules during clone, rewriting the SSH remote to HTTPS",
    async () => {
      addGitmodules(repo);
      const res = await bootstrapRepo(
        d,
        repo.url,
        withCreds(repo.url, [{ host: HOST, token: TOKEN }]),
      );
      expect(res.status).toBe(200);
      await waitForOrchestratorIdle(d, SETUP_TIMEOUT_MS);

      const log = cloneLog(d);
      // The step runs at all — before this existed it was silently skipped and
      // the dev server died on unresolved submodule imports.
      expect(log).toContain("submodule update --init --recursive --depth 1");
      // …with the SSH→HTTPS rewrite, so a store credential can apply to a
      // `git@host:` submodule URL…
      expect(log).toContain(`url.https://${HOST}/.insteadOf=git@${HOST}:`);
      // …and it reached git: the remote it actually dialed is the rewritten
      // HTTPS one, not the `git@` form in .gitmodules. Positive evidence — the
      // absence of an ssh error would also hold if git had produced no output.
      // (git still echoes the configured `git@…` URL in its own "clone of …
      // failed" line, so only the access attempt discriminates.)
      expect(log).toContain(`unable to access 'https://${HOST}/acme/bff.git`);
      // The token rides the credentials file, never argv or the log.
      expect(log).not.toContain(TOKEN);

      // Best-effort: the unreachable submodule warned, the checkout survived.
      expect(log).toContain("continuing without submodules");
      expect(existsSync(join(d.appDir, "repo", "README.md"))).toBe(true);
    },
    SETUP_TIMEOUT_MS,
  );

  it(
    "leaves submodules alone when no credentials are supplied (opt-in)",
    async () => {
      addGitmodules(repo);
      expect((await bootstrapRepo(d, repo.url)).status).toBe(200);
      await waitForOrchestratorIdle(d, SETUP_TIMEOUT_MS);

      expect(existsSync(join(d.appDir, "repo", "README.md"))).toBe(true);
      // cloneLog throws on an empty/absent log, so this can't pass vacuously.
      expect(cloneLog(d)).not.toContain("submodule");
    },
    SETUP_TIMEOUT_MS,
  );

  it(
    "stops using a credential the next config revokes",
    async () => {
      addGitmodules(repo);
      expect(
        (
          await bootstrapRepo(
            d,
            repo.url,
            withCreds(repo.url, [{ host: HOST, token: TOKEN }]),
          )
        ).status,
      ).toBe(200);
      await waitForOrchestratorIdle(d, SETUP_TIMEOUT_MS);
      expect(cloneLog(d)).toContain("submodule update --init");

      // The payload Studio sends when the user deletes their last credential
      // row: the key is present and empty, never absent — absent means "keep
      // current" to the daemon, which would leave the revoked PAT live.
      expect((await postConfig(d, withCreds(repo.url, []))).status).toBe(200);

      const read = await fetch(url(d, "/_sandbox/config"), {
        headers: authHeaders(),
      });
      const body = await read.text();
      expect(body).not.toContain(TOKEN);
      expect(body).not.toContain("submoduleCredentials");
    },
    SETUP_TIMEOUT_MS,
  );

  it(
    "warns and skips a credential whose host is not a bare hostname",
    async () => {
      addGitmodules(repo);
      // A host carrying a scheme would corrupt the insteadOf prefix and the
      // credential URL — it must be rejected, not sanitized.
      const res = await bootstrapRepo(
        d,
        repo.url,
        withCreds(repo.url, [{ host: `https://${HOST}`, token: TOKEN }]),
      );
      expect(res.status).toBe(200);
      await waitForOrchestratorIdle(d, SETUP_TIMEOUT_MS);

      const log = cloneLog(d);
      expect(log).toContain("invalid host");
      // No valid host left → the fetch never runs.
      expect(log).not.toContain("submodule update --init");
      expect(existsSync(join(d.appDir, "repo", "README.md"))).toBe(true);
    },
    SETUP_TIMEOUT_MS,
  );

  it(
    "never returns the submodule token on /config (write echo or read)",
    async () => {
      // /_sandbox/config is proxied to the browser. If the resolved PAT came
      // back out, any org secret referenceable from the Sandbox card would be
      // readable by anyone who can reach the sandbox.
      const put = await postConfig(
        d,
        withCreds(repo.url, [{ host: HOST, token: TOKEN }]),
      );
      expect(put.status).toBe(200);
      const echo = await put.text();
      expect(echo).not.toContain(TOKEN);
      expect(echo).not.toContain("submoduleCredentials");

      const read = await fetch(url(d, "/_sandbox/config"), {
        headers: authHeaders(),
      });
      expect(read.status).toBe(200);
      const body = await read.text();
      expect(body).not.toContain(TOKEN);
      expect(body).not.toContain("submoduleCredentials");
      // The clone URL still round-trips, so this isn't passing by returning
      // nothing at all.
      expect(body).toContain("cloneUrl");
    },
    SETUP_TIMEOUT_MS,
  );
});
