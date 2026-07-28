import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../types";
import {
  publishRemoteGolden,
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

/** The one archive under the store: <root>/golden/<repoHash>/<pm>-<lock>.tar.zst */
async function soleArchive(
  root: string,
): Promise<{ dir: string; path: string }> {
  const [repo] = await readdir(join(root, "golden"));
  const dir = join(root, "golden", repo);
  const [name] = await readdir(dir);
  return { dir, path: join(dir, name) };
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
});
