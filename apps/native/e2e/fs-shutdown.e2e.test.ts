/**
 * Black-box ordering contract for filesystem mutation shutdown.
 *
 * A slow streaming `write_from_url` must never write directly into the Git
 * worktree. SIGTERM cancels and joins its detached preparation owner before
 * the shutdown publish hook runs: an earlier completed write is pushed, while
 * neither a partial target nor mutation-stage residue reaches the repository.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { retry, sleep } from "@decocms/shared/std";
import { afterEach, expect, it } from "bun:test";

import {
  describeLocalApi,
  jsonAuthHeaders,
  startLocalApi,
  stopLocalApi,
  url,
  type LocalApi,
} from "./helpers";

const RETRY_OPTIONS = {
  maxAttempts: 200,
  minTimeout: 20,
  maxTimeout: 50,
  jitter: 0,
} as const;

let api: LocalApi | null = null;
let originRoot: string | null = null;
let source: ReturnType<typeof Bun.serve> | null = null;

function git(cwd: string, args: string[], allowFailure = false): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (!allowFailure && result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed in ${cwd}: ${result.stderr || result.stdout}`,
    );
  }
  return result.stdout;
}

function configurePublishFixture(localApi: LocalApi): string {
  const root = mkdtempSync(join(tmpdir(), "native-fs-shutdown-origin-"));
  originRoot = root;
  const bare = join(root, "origin.git");
  const repo = join(localApi.workdir, "repo");
  git(root, ["init", "--bare", "-q", bare]);
  git(repo, ["init", "-q", "-b", "sandbox-work"]);
  git(repo, ["config", "user.name", "Filesystem Shutdown Test"]);
  git(repo, ["config", "user.email", "fs-shutdown@example.com"]);
  writeFileSync(join(repo, "baseline.txt"), "baseline\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "baseline"]);
  git(repo, ["remote", "add", "origin", bare]);
  git(repo, ["push", "-q", "-u", "origin", "sandbox-work"]);
  return bare;
}

afterEach(async () => {
  source?.stop(true);
  source = null;
  await stopLocalApi(api);
  api = null;
  if (originRoot) rmSync(originRoot, { recursive: true, force: true });
  originRoot = null;
});

describeLocalApi("local-api e2e: filesystem shutdown ordering", () => {
  it("cancels a staged download before publishing and leaves no partial worktree file", async () => {
    const first = await startLocalApi({ LOCAL_API_TOKEN_STORE: "memory" });
    api = first;
    const bare = configurePublishFixture(first);
    const repo = join(first.workdir, "repo");

    const completed = await fetch(url(first, "/_sandbox/write"), {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: JSON.stringify({
        path: "before-shutdown.txt",
        content: "must be published\n",
      }),
    });
    expect(completed.status).toBe(200);

    let sourceStarted = false;
    let sourceCancelled = false;
    source = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        sourceStarted = true;
        let cancelled = false;
        return new Response(
          new ReadableStream<Uint8Array>({
            async start(controller) {
              controller.enqueue(new TextEncoder().encode("partial-data"));
              while (!cancelled) {
                await sleep(25);
                if (cancelled) break;
                try {
                  controller.enqueue(new Uint8Array(1024));
                } catch {
                  break;
                }
              }
            },
            cancel() {
              cancelled = true;
              sourceCancelled = true;
            },
          }),
        );
      },
    });

    const slowRequest = fetch(url(first, "/_sandbox/write_from_url"), {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: JSON.stringify({
        path: "slow-download.bin",
        url: `http://127.0.0.1:${source.port}/slow`,
      }),
    }).catch(() => null);
    await retry(async () => {
      if (!sourceStarted) throw new Error("download source was not reached");
    }, RETRY_OPTIONS);

    const shutdownStartedAt = Date.now();
    expect(first.proc.kill("SIGTERM")).toBe(true);
    await retry(async () => {
      if (first.proc.exitCode === null && first.proc.signalCode === null) {
        throw new Error("local-api has not completed graceful shutdown");
      }
    }, RETRY_OPTIONS);
    await Promise.race([slowRequest, sleep(1_000)]);

    expect(Date.now() - shutdownStartedAt).toBeLessThan(15_000);
    expect(first.proc.exitCode).toBe(0);
    expect(existsSync(join(repo, "slow-download.bin"))).toBe(false);
    expect(readFileSync(join(repo, "before-shutdown.txt"), "utf8")).toBe(
      "must be published\n",
    );
    expect(git(bare, ["show", "sandbox-work:before-shutdown.txt"]).trim()).toBe(
      "must be published",
    );
    const partialInRemote = spawnSync(
      "git",
      ["show", "sandbox-work:slow-download.bin"],
      { cwd: bare, encoding: "utf8" },
    );
    expect(partialInRemote.status).not.toBe(0);

    const stages = join(first.workdir, ".decocms", "mutations");
    expect(existsSync(stages) ? readdirSync(stages) : []).toEqual([]);
    await retry(async () => {
      if (!sourceCancelled) {
        throw new Error("download connection has not observed cancellation");
      }
    }, RETRY_OPTIONS);

    // The instance lock remains held until mutation cancellation, publish,
    // and listener drain all finish. Immediate same-root restart proves no
    // detached filesystem owner retained the previous server lifecycle.
    const restarted = await startLocalApi(
      { LOCAL_API_TOKEN_STORE: "memory" },
      { workdir: first.workdir },
    );
    api = restarted;
    const health = await fetch(url(restarted, "/health"));
    expect(health.status).toBe(200);
  }, 20_000);
});
