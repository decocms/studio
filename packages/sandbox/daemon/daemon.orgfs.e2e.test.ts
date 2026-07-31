/**
 * Daemon conformance suite — ORG-FS LINKS (cluster/sidecar path).
 *
 * A hosted sandbox's main container cannot mount; a privileged sidecar mounts
 * the org volumes at `<appRoot>/org/<volume>` and reports what it mounted in a
 * status file on a shared control volume. The daemon's job is the *links* that
 * make those volumes reachable the way the prompts assume:
 *
 *   - `<repoDir>/org` → `../org`, so a harness shell (cwd `<appRoot>/repo`)
 *     resolves relative `org/...` paths, and the link is `.git/info/exclude`d so
 *     the shutdown `git add -A` never commits it to a user branch;
 *   - `org/output` → `.outputs/<threadId>` and `org/upload` →
 *     `.uploads/<threadId>`, repointed per run so an agent writing the bare link
 *     path lands in the *running* thread's subtree.
 *
 * The sidecar is faked here (its own runtime is not what this asserts): a status
 * file plus real mount-point dirs. What matters is the gate — the daemon must
 * link ONLY what the status file reports live. A mount-point dir exists locally
 * even when the mount failed, so linking on directory existence alone would
 * silently strand the user's shared files on the pod's ephemeral disk, which is
 * exactly the failure this suite exists to prevent.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type BareRepo,
  authHeaders,
  type Daemon,
  HOOK_TIMEOUT_MS,
  bootstrapRepo,
  setupBareRepo,
  startDaemon,
  stopDaemon,
  url,
  waitForOrchestratorIdle,
} from "./daemon.e2e.helpers";

const SETUP_TIMEOUT_MS = 60_000;
// A tool call that finds no live mount pays the daemon's one-shot, fail-open
// first-mount grace wait (~10s) before proceeding without links.
const NO_MOUNT_TIMEOUT_MS = 60_000;

let d: Daemon | null = null;
let repo: BareRepo | null = null;
let ctlDir: string | null = null;

beforeEach(() => {
  ctlDir = mkdtempSync(join(tmpdir(), "daemon-e2e-orgfs-ctl-"));
  repo = setupBareRepo();
});

afterEach(async () => {
  await stopDaemon(d);
  d = null;
  repo?.cleanup();
  repo = null;
  if (ctlDir) rmSync(ctlDir, { recursive: true, force: true });
  ctlDir = null;
}, HOOK_TIMEOUT_MS);

/** Boot a daemon wired to a faked org-fs sidecar control volume. */
async function startWithSidecar(): Promise<Daemon> {
  return startDaemon({
    ORGFS_SIDECAR_CONFIG_PATH: join(ctlDir!, "config.json"),
    ORGFS_SIDECAR_STATUS_PATH: join(ctlDir!, "status.json"),
  });
}

/**
 * Play the sidecar: create the mount-point dirs and report them live. Volumes
 * not listed here are "not mounted" even if their directory exists.
 */
function fakeSidecarMounts(daemon: Daemon, volumes: string[]): void {
  const mounts = volumes.map((dir) => {
    const mountPath = join(daemon.appDir, "org", dir);
    mkdirSync(mountPath, { recursive: true });
    return { volume: dir.replace(/^\./, ""), mountPath };
  });
  writeFileSync(join(ctlDir!, "status.json"), JSON.stringify({ mounts }));
}

/** A workspace tool call, optionally stamped with the running thread. */
async function toolCall(daemon: Daemon, threadId?: string): Promise<Response> {
  return fetch(url(daemon, "/_sandbox/glob"), {
    method: "POST",
    headers: authHeaders({
      "Content-Type": "application/json",
      ...(threadId ? { "x-thread-id": threadId } : {}),
    }),
    body: JSON.stringify({ pattern: "*.md" }),
  });
}

describe("daemon e2e: org-fs links", () => {
  it(
    "links the repo and points output/upload at the calling thread",
    async () => {
      d = await startWithSidecar();
      fakeSidecarMounts(d, [".outputs", ".uploads"]);
      expect((await bootstrapRepo(d, repo!.url)).status).toBe(200);
      await waitForOrchestratorIdle(d);

      expect((await toolCall(d, "thread-abc")).status).toBe(200);

      // Relative targets, so the tree survives being moved.
      expect(readlinkSync(join(d.appDir, "org", "output"))).toBe(
        join(".outputs", "thread-abc"),
      );
      expect(readlinkSync(join(d.appDir, "org", "upload"))).toBe(
        join(".uploads", "thread-abc"),
      );
      // The thread's subtree is created through the mount, not assumed.
      expect(existsSync(join(d.appDir, "org", ".outputs", "thread-abc"))).toBe(
        true,
      );

      // Reachable from the harness cwd, and never committed to a user branch.
      expect(readlinkSync(join(d.appDir, "repo", "org"))).toBe(
        join("..", "org"),
      );
      const exclude = readFileSync(
        join(d.appDir, "repo", ".git", "info", "exclude"),
        "utf8",
      );
      expect(exclude.split("\n")).toContain("/org");

      // A second thread in the same sandbox repoints the shared link.
      expect((await toolCall(d, "thread-def")).status).toBe(200);
      expect(readlinkSync(join(d.appDir, "org", "output"))).toBe(
        join(".outputs", "thread-def"),
      );
    },
    SETUP_TIMEOUT_MS,
  );

  it(
    "links nothing while the sidecar reports no live mount",
    async () => {
      d = await startWithSidecar();
      // The mount-point dir exists (the sidecar created it, or a previous boot
      // did) but nothing is mounted on it.
      mkdirSync(join(d.appDir, "org", ".outputs"), { recursive: true });
      fakeSidecarMounts(d, []);
      expect((await bootstrapRepo(d, repo!.url)).status).toBe(200);
      await waitForOrchestratorIdle(d);

      // Fail-open: the call still succeeds, it just gets no links.
      expect((await toolCall(d, "thread-abc")).status).toBe(200);
      expect(existsSync(join(d.appDir, "org", "output"))).toBe(false);
      expect(existsSync(join(d.appDir, "repo", "org"))).toBe(false);
    },
    NO_MOUNT_TIMEOUT_MS,
  );

  it(
    "refuses a threadId that is not a single path segment",
    async () => {
      d = await startWithSidecar();
      fakeSidecarMounts(d, [".outputs"]);
      expect((await bootstrapRepo(d, repo!.url)).status).toBe(200);
      await waitForOrchestratorIdle(d);

      expect((await toolCall(d, "../../etc")).status).toBe(200);
      expect(existsSync(join(d.appDir, "org", "output"))).toBe(false);
    },
    SETUP_TIMEOUT_MS,
  );

  it(
    "never shadows a repo that tracks its own org/ directory",
    async () => {
      d = await startWithSidecar();
      fakeSidecarMounts(d, [".outputs"]);
      expect((await bootstrapRepo(d, repo!.url)).status).toBe(200);
      await waitForOrchestratorIdle(d);
      // A real directory where the link would go — user content wins.
      const repoOrg = join(d.appDir, "repo", "org");
      mkdirSync(repoOrg, { recursive: true });
      writeFileSync(join(repoOrg, "mine.txt"), "user content\n");

      expect((await toolCall(d, "thread-abc")).status).toBe(200);

      expect(lstatSync(repoOrg).isSymbolicLink()).toBe(false);
      expect(readFileSync(join(repoOrg, "mine.txt"), "utf8")).toBe(
        "user content\n",
      );
    },
    SETUP_TIMEOUT_MS,
  );

  it(
    "stays inert when the pod has no org-fs sidecar",
    async () => {
      d = await startDaemon();
      expect((await bootstrapRepo(d, repo!.url)).status).toBe(200);
      await waitForOrchestratorIdle(d);

      expect((await toolCall(d, "thread-abc")).status).toBe(200);
      expect(existsSync(join(d.appDir, "org"))).toBe(false);
      expect(existsSync(join(d.appDir, "repo", "org"))).toBe(false);
    },
    SETUP_TIMEOUT_MS,
  );
});
