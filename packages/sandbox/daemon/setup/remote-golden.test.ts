import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { randomFillSync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../types";
import {
  publishRemoteGolden,
  pruneRemoteGoldens,
  remoteGoldenPath,
  tryRestoreRemoteGolden,
} from "./remote-golden";

const CLONE_URL = "https://user:tok@github.com/acme/site.git";

function config(): Config {
  return {
    git: { repository: { cloneUrl: CLONE_URL } },
  } as unknown as Config;
}

/** A repo root with a lockfile (required — no lockfile means no cache key). */
async function makeInstallRoot(base: string, name: string): Promise<string> {
  const root = join(base, name);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "bun.lock"), '{"lockfileVersion":1}');
  return root;
}

async function seedNodeModules(root: string): Promise<void> {
  await mkdir(join(root, "node_modules", "left-pad"), { recursive: true });
  await writeFile(
    join(root, "node_modules", "left-pad", "index.js"),
    "module.exports = 1;",
  );
  // Pod-local caches — must not travel in a shared archive.
  await mkdir(join(root, "node_modules", ".vite", "deps"), { recursive: true });
  await writeFile(join(root, "node_modules", ".vite", "deps", "x"), "junk");
}

/**
 * A tree big enough that `tar -x` (many small writes) falls behind
 * `zstd -dc`, so the transfer actually has to survive backpressure.
 *
 * Incompressible content on purpose: zstd must move real bytes, not collapse
 * the whole thing into a few KB. 1500 files x 6 KB ≈ 9 MB — comfortably past
 * the ~1 MB floor below which a relayed pipe never drops anything, which is
 * exactly why the small fixtures above missed this.
 */
const BIG_FILES = 1500;
const BIG_FILE_BYTES = 6 * 1024;

async function seedBigNodeModules(root: string): Promise<void> {
  const dir = join(root, "node_modules", "bulk");
  await mkdir(dir, { recursive: true });
  await Promise.all(
    Array.from({ length: BIG_FILES }, (_, i) => {
      const buf = Buffer.alloc(BIG_FILE_BYTES);
      randomFillSync(buf);
      // Stamp the index so a truncated-but-plausible extract can't pass by
      // having the right count with the wrong contents.
      buf.write(`file-${i};`, 0);
      return writeFile(join(dir, `f${i}.bin`), buf);
    }),
  );
}

/**
 * The one archive under the store: <root>/golden/<repoHash>/<pm>-<lock>.tar.zst
 *
 * Asserts rather than destructures blindly: when publish silently produced
 * nothing, the bare `join(dir, undefined)` threw ERR_INVALID_ARG_TYPE from in
 * here, which reads as a broken helper rather than "publish failed". Combined
 * with `publishRemoteGolden` swallowing its own diagnostics when no `log` is
 * passed, a real EPIPE in the transport surfaced as a confusing TypeError.
 */
async function soleArchive(
  root: string,
): Promise<{ dir: string; path: string }> {
  const repos = await readdir(join(root, "golden"));
  expect(repos, "publish created no repo dir under the store").toHaveLength(1);
  const dir = join(root, "golden", repos[0] as string);
  const names = (await readdir(dir)).filter((n) => n.endsWith(".tar.zst"));
  expect(names, `publish left no archive in ${dir}`).toHaveLength(1);
  return { dir, path: join(dir, names[0] as string) };
}

/** Collects the transport's own failure messages so a test can report them. */
function logger(): { log: (m: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { log: (m) => lines.push(m), lines };
}

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

let base: string;
let remoteRoot: string;
const prevRemote = process.env.GOLDEN_CACHE_REMOTE;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "l2-"));
  remoteRoot = join(base, "shared");
  await mkdir(remoteRoot, { recursive: true });
  process.env.GOLDEN_CACHE_REMOTE = remoteRoot;
});

afterEach(async () => {
  if (prevRemote === undefined) delete process.env.GOLDEN_CACHE_REMOTE;
  else process.env.GOLDEN_CACHE_REMOTE = prevRemote;
  await rm(base, { recursive: true, force: true });
});

describe("remote golden (L2)", () => {
  test("publishes on one node and restores on another", async () => {
    // "Node A" installs and publishes.
    const nodeA = await makeInstallRoot(base, "node-a");
    await seedNodeModules(nodeA);
    await publishRemoteGolden({
      config: config(),
      installRoot: nodeA,
      pm: "bun",
    });

    const archive = remoteGoldenPath({
      remoteRoot,
      cloneUrl: CLONE_URL,
      pm: "bun",
      lockHash: null,
    });
    // lockHash null → no key at all; the real path needs the lockfile read.
    expect(archive).toBeNull();

    // "Node B" is cold: same repo, same lockfile, empty node_modules. This is
    // the whole point of L2 — a node that never saw this repo still skips
    // the install.
    const nodeB = await makeInstallRoot(base, "node-b");
    const restored = await tryRestoreRemoteGolden({
      config: config(),
      installRoot: nodeB,
      pm: "bun",
    });

    expect(restored).toBe(true);
    expect(
      await readFile(
        join(nodeB, "node_modules", "left-pad", "index.js"),
        "utf8",
      ),
    ).toBe("module.exports = 1;");

    // Pod-local caches were excluded at publish, so they must not appear.
    expect(await exists(join(nodeB, "node_modules", ".vite"))).toBe(false);

    // No staging dir left behind.
    const leftovers = join(nodeB, `.node_modules.l2.${process.pid}`);
    expect(await exists(leftovers)).toBe(false);
  });

  test("round-trips a tree large enough to apply backpressure", async () => {
    // The regression guard for the fd-to-fd pipe. Relaying the archive through
    // this process (`p.stdout.pipe(c.stdin)`) silently dropped the tail once
    // the consumer fell behind — and BOTH children still exited 0, so the
    // truncation surfaced only later as `tar: Unexpected EOF in archive`, or
    // worse, as a permanently-published archive holding half its members.
    // Every other test here uses a ~1 KB fixture, under the size where the
    // loss ever happened; without this one a revert to the relayed pipe stays
    // green.
    const nodeA = await makeInstallRoot(base, "big-a");
    await seedBigNodeModules(nodeA);
    const pub = logger();
    await publishRemoteGolden({
      config: config(),
      installRoot: nodeA,
      pm: "bun",
      log: pub.log,
    });
    // Surface the transport's own message. Without this a broken pipe or a
    // failed read-back shows up only as "no archive", one layer too late.
    expect(pub.lines.filter((l) => !l.includes("published"))).toEqual([]);

    // Publish must not declare success on a truncated archive.
    const { path } = await soleArchive(remoteRoot);
    expect(await exists(path)).toBe(true);

    const nodeB = await makeInstallRoot(base, "big-b");
    expect(
      await tryRestoreRemoteGolden({
        config: config(),
        installRoot: nodeB,
        pm: "bun",
      }),
    ).toBe(true);

    // Exact count, not "some files" — the observed failure delivered 532 of
    // 1069 members and looked fine at a glance.
    const restored = await readdir(join(nodeB, "node_modules", "bulk"));
    expect(restored.length).toBe(BIG_FILES);

    // Spot-check both ends of the stream: a dropped tail is what this catches,
    // so the LAST member matters most.
    for (const i of [0, BIG_FILES - 1]) {
      const buf = await readFile(
        join(nodeB, "node_modules", "bulk", `f${i}.bin`),
      );
      expect(buf.length).toBe(BIG_FILE_BYTES);
      expect(buf.subarray(0, `file-${i};`.length).toString()).toBe(
        `file-${i};`,
      );
    }
  }, 60_000);

  test("does nothing when the shared store is not configured", async () => {
    // The discriminating case: identical setup, feature off. Without this the
    // test above would pass even if the code ignored the env entirely.
    const nodeA = await makeInstallRoot(base, "off-a");
    await seedNodeModules(nodeA);
    delete process.env.GOLDEN_CACHE_REMOTE;

    await publishRemoteGolden({
      config: config(),
      installRoot: nodeA,
      pm: "bun",
    });
    const nodeB = await makeInstallRoot(base, "off-b");
    expect(
      await tryRestoreRemoteGolden({
        config: config(),
        installRoot: nodeB,
        pm: "bun",
      }),
    ).toBe(false);
    expect(await exists(join(nodeB, "node_modules"))).toBe(false);
  });

  test("a truncated archive fails closed, leaving no partial tree", async () => {
    // The failure that would be worst: a half-extracted node_modules that
    // later code reads as complete, so the boot skips install and breaks
    // somewhere unrelated. Restore must leave nothing behind.
    const nodeA = await makeInstallRoot(base, "trunc-a");
    await seedNodeModules(nodeA);
    await publishRemoteGolden({
      config: config(),
      installRoot: nodeA,
      pm: "bun",
    });

    const nodeB = await makeInstallRoot(base, "trunc-b");
    const { path } = await soleArchive(remoteRoot);
    await writeFile(path, "not a zstd stream");

    expect(
      await tryRestoreRemoteGolden({
        config: config(),
        installRoot: nodeB,
        pm: "bun",
      }),
    ).toBe(false);
    expect(await exists(join(nodeB, "node_modules"))).toBe(false);
    expect(await exists(join(nodeB, `.node_modules.l2.${process.pid}`))).toBe(
      false,
    );
  });

  test("publish is idempotent and does not rewrite an existing archive", async () => {
    const nodeA = await makeInstallRoot(base, "idem-a");
    await seedNodeModules(nodeA);
    const opts = { config: config(), installRoot: nodeA, pm: "bun" };
    await publishRemoteGolden(opts);

    const { dir, path } = await soleArchive(remoteRoot);
    const first = await stat(path);

    // A second healthy boot on another node must not rewrite the archive —
    // concurrent publishers across the fleet would otherwise churn the
    // shared store on every boot.
    await publishRemoteGolden(opts);
    expect((await stat(path)).mtimeMs).toBe(first.mtimeMs);

    // And no temp file survived.
    expect((await readdir(dir)).filter((e) => e.includes(".tmp."))).toEqual([]);
  });

  test("prune bounds the store by TTL and per-repo cap", async () => {
    const nodeA = await makeInstallRoot(base, "gc-a");
    await seedNodeModules(nodeA);
    await publishRemoteGolden({
      config: config(),
      installRoot: nodeA,
      pm: "bun",
    });
    const { dir, path: fresh } = await soleArchive(remoteRoot);

    // Three older archives (one already past the TTL) plus an in-flight temp
    // from a concurrent publisher on another node.
    const day = 24 * 60 * 60 * 1000;
    const aged: string[] = [];
    for (const [i, ageDays] of [1, 2, 9].entries()) {
      const p = join(dir, `bun-old${i}.tar.zst`);
      await writeFile(p, "x");
      const t = new Date(Date.now() - ageDays * day);
      await utimes(p, t, t);
      aged.push(p);
    }
    const inflight = join(dir, "bun-new.tar.zst.tmp.999");
    await writeFile(inflight, "half an archive");

    await pruneRemoteGoldens(remoteRoot, { maxPerRepo: 2 });

    // Newest 2 by mtime survive the cap; the 9-day-old one is past the TTL and
    // would be dropped even under a generous cap.
    expect(await exists(fresh)).toBe(true);
    expect(await exists(aged[0] as string)).toBe(true);
    expect(await exists(aged[1] as string)).toBe(false);
    expect(await exists(aged[2] as string)).toBe(false);
    // A temp file is another node's in-flight publish, not a prunable entry —
    // reaping it would corrupt a publish already in progress.
    expect(await exists(inflight)).toBe(true);
  });

  test("a successful publish prunes the store", async () => {
    // The wiring, not the rule: without this the store still grows forever
    // however correct pruneRemoteGoldens is on its own.
    const nodeA = await makeInstallRoot(base, "gcw-a");
    await seedNodeModules(nodeA);
    await publishRemoteGolden({
      config: config(),
      installRoot: nodeA,
      pm: "bun",
    });
    const { dir } = await soleArchive(remoteRoot);

    const stale = join(dir, "bun-stale.tar.zst");
    await writeFile(stale, "x");
    const old = new Date(Date.now() - 9 * 24 * 60 * 60 * 1000);
    await utimes(stale, old, old);

    // A new lockfile is a new key, so this publish is not the idempotent no-op.
    await writeFile(join(nodeA, "bun.lock"), '{"lockfileVersion":2}');
    await publishRemoteGolden({
      config: config(),
      installRoot: nodeA,
      pm: "bun",
    });

    expect(await exists(stale)).toBe(false);
    // Both real keys are recent, so the cap keeps them.
    expect((await readdir(dir)).length).toBe(2);
  });
});
