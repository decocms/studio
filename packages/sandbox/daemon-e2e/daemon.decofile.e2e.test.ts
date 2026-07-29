/**
 * Black-box e2e for GET /_sandbox/decofile.
 *
 * The route a production site pulls its draft from (pull-based Fast Preview).
 * Same contract as the rest of the daemon suite: spawn the built daemon, talk
 * to it over HTTP, assert only on responses and the workspace filesystem.
 */
import { afterEach, beforeEach, describe, expect, it, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type Daemon,
  HOOK_TIMEOUT_MS,
  jsonAuthHeaders,
  readSseUntil,
  startDaemon,
  stopDaemon,
  url,
} from "./daemon.e2e.helpers";

let d: Daemon | null = null;

/** `<appRoot>/repo/.deco/blocks` — the sources the decofile is merged from. */
function blocksDir(daemon: Daemon): string {
  return join(daemon.appDir, "repo", ".deco", "blocks");
}

async function writeBlock(
  daemon: Daemon,
  name: string,
  body: unknown,
): Promise<void> {
  await mkdir(blocksDir(daemon), { recursive: true });
  await writeFile(
    join(blocksDir(daemon), `${name}.json`),
    JSON.stringify(body),
    "utf-8",
  );
}

beforeEach(async () => {
  d = await startDaemon();
}, HOOK_TIMEOUT_MS);

afterEach(async () => {
  await stopDaemon(d);
  d = null;
}, HOOK_TIMEOUT_MS);

describe("GET /_sandbox/decofile", () => {
  test("404s when there are no blocks to merge", async () => {
    const res = await fetch(url(d!, "/_sandbox/decofile"));
    expect(res.status).toBe(404);
  });

  test("serves the merged blocks with a content ETag", async () => {
    await writeBlock(d!, "pages-home", { path: "/", sections: [] });
    await writeBlock(d!, "Header", {
      __resolveType: "site/sections/Header.tsx",
    });

    const res = await fetch(url(d!, "/_sandbox/decofile"));
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toMatch(/^W\/"[0-9a-f]+"$/);
    // Never let a shared cache hold an unpublished draft.
    expect(res.headers.get("cache-control")).toBe("no-store");

    const body = (await res.json()) as Record<string, unknown>;
    // Filename stem is the block key — the shape the deco runtime emits.
    expect(Object.keys(body).sort()).toEqual(["Header", "pages-home"]);
    expect(body["pages-home"]).toEqual({ path: "/", sections: [] });
  });

  test("decodes double-encoded filenames to the real block key", async () => {
    // Real repos carry both encodings: `Compre%20Junto.json` (single) and
    // `Compre%2520Junto.json` (double). Both must merge under "Compre Junto" —
    // a single decode leaves the double-encoded one keyed "Compre%20Junto",
    // which no `__resolveType` reference resolves.
    await writeBlock(d!, "Compre%2520Junto", { curated: true });
    await writeBlock(d!, "Card%20config", { plain: true });

    const res = await fetch(url(d!, "/_sandbox/decofile"));
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["Card config", "Compre Junto"]);
  });

  test("is unauthenticated — the fetcher is a site, not the cluster", async () => {
    // Deliberately no Authorization header: the production server pulling this
    // has no daemon token. Matched ahead of the bearer gate in entry.ts.
    await writeBlock(d!, "pages-home", { path: "/", sections: [] });
    const res = await fetch(url(d!, "/_sandbox/decofile"));
    expect(res.status).toBe(200);
  });

  test("ETag is stable across reads and changes with content", async () => {
    await writeBlock(d!, "pages-home", { path: "/", sections: [] });

    const first = await fetch(url(d!, "/_sandbox/decofile"));
    const etag1 = first.headers.get("etag");
    await first.text();

    const again = await fetch(url(d!, "/_sandbox/decofile"));
    const etag2 = again.headers.get("etag");
    await again.text();
    expect(etag2).toBe(etag1);

    await writeBlock(d!, "pages-home", { path: "/", sections: [{ x: 1 }] });
    const changed = await fetch(url(d!, "/_sandbox/decofile"));
    await changed.text();
    expect(changed.headers.get("etag")).not.toBe(etag1);
  });

  test("revalidates: 304 on a matching ETag, full body on a stale one", async () => {
    await writeBlock(d!, "pages-home", { path: "/", sections: [] });

    const first = await fetch(url(d!, "/_sandbox/decofile"));
    const etag = first.headers.get("etag") ?? "";
    await first.text();

    const fresh = await fetch(url(d!, "/_sandbox/decofile"), {
      headers: { "if-none-match": etag },
    });
    expect(fresh.status).toBe(304);
    expect((await fresh.text()).length).toBe(0);

    const stale = await fetch(url(d!, "/_sandbox/decofile"), {
      headers: { "if-none-match": 'W/"deadbeef"' },
    });
    expect(stale.status).toBe(200);
    expect((await stale.text()).length).toBeGreaterThan(0);
  });

  test("announces a new version on the events stream after a block write", async () => {
    // The signal Studio rebuilds its draft pointer from. Without it a save
    // would not refresh the preview — Studio would have to poll a multi-MB
    // payload just to read its hash.
    await writeBlock(d!, "pages-home", { path: "/", sections: [] });

    // Land the write while the stream is open, so the event is observed live
    // rather than replayed from connect.
    const pending = readSseUntil(url(d!, "/_sandbox/events"), {
      predicate: (acc) => acc.includes("event: decofile"),
      deadlineMs: 15_000,
    });
    await new Promise((r) => setTimeout(r, 500));

    // Write through the daemon's own route rather than straight to disk: that
    // is how the CMS actually saves a block, and it signals `onWorkingTreeWrite`
    // directly. A bare fs write would rely on BranchStatusMonitor's watcher,
    // which only starts once the repo is a real git checkout.
    const saved = await fetch(url(d!, "/_sandbox/write"), {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: JSON.stringify({
        path: ".deco/blocks/pages-home.json",
        content: JSON.stringify({ path: "/", sections: [{ n: 1 }] }),
      }),
    });
    expect(saved.status).toBe(200);

    const { text } = await pending;
    const line = text
      .split("\n")
      .find((l) => l.startsWith("data:") && l.includes("version"));
    expect(line).toBeDefined();
    const { version } = JSON.parse(line!.slice("data:".length).trim()) as {
      version: string;
    };

    // Must be the SAME value the route serves as its ETag — one definition, or
    // Studio's pointer and the framework's cache key drift apart.
    const res = await fetch(url(d!, "/_sandbox/decofile"));
    await res.text();
    expect(res.headers.get("etag")).toBe(`W/"${version}"`);
  }, 30_000);
});

// Inlined copy of the web consumer's stripLineNumbers (read-committed-file.ts →
// file-explorer/utils.ts): strips a leading `^\d+\t` from every `\n`-split line.
// The e2e can't import app code (ban-e2e-app-imports), so it owns this contract
// — a divergence from the real consumer is a wire-contract regression signal.
const stripLineNumbers = (content: string): string =>
  content
    .split("\n")
    .map((line) => line.replace(/^\d+\t/, ""))
    .join("\n");

const readFallback = (d: Daemon, path: string) =>
  fetch(url(d, "/_sandbox/read"), {
    method: "POST",
    headers: jsonAuthHeaders(),
    body: JSON.stringify({ path, full: true }),
  });

describe("daemon e2e: decofile /read fallback", () => {
  it("synthesizes blocks.gen.json from .deco/blocks/*.json when absent", async () => {
    await writeBlock(d!, "b", { n: 2 });
    await writeBlock(d!, "a", { n: 1 });

    const res = await readFallback(d!, ".deco/blocks.gen.json");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { kind: string; content: string };
    expect(body.kind).toBe("text");
    // Sorted by filename, keyed by decoded stem, spliced raw — deterministic.
    expect(body.content).toBe(`{"a":{"n":1},"b":{"n":2}}`);
    // The consumer strips a leading `^\d+\t` per line; the payload must not
    // carry one, so JSON.parse of the (no-op) stripped content still works.
    expect(JSON.parse(body.content)).toEqual({ a: { n: 1 }, b: { n: 2 } });
  });

  it("survives the consumer's stripLineNumbers on pretty-printed blocks", async () => {
    // Blocks are written to disk pretty-printed (JSON.stringify(data, null, 2)),
    // so the merged blob is multi-line. The real consumer always does
    // JSON.parse(stripLineNumbers(content)) — exercise that exact path, not a
    // bare JSON.parse, so a regression that re-numbers this response is caught.
    await mkdir(blocksDir(d!), { recursive: true });
    await writeFile(
      join(blocksDir(d!), "hero.json"),
      JSON.stringify({ title: "Hi", count: 3 }, null, 2),
      "utf-8",
    );
    await writeFile(
      join(blocksDir(d!), "shelf.json"),
      JSON.stringify({ items: [1, 2] }, null, 2),
      "utf-8",
    );

    const res = await readFallback(d!, ".deco/blocks.gen.json");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { content: string };
    expect(body.content).toContain("\n"); // genuinely multi-line
    expect(JSON.parse(stripLineNumbers(body.content))).toEqual({
      hero: { title: "Hi", count: 3 },
      shelf: { items: [1, 2] },
    });
  });

  it("decodes percent-encoded block stems until stable", async () => {
    await writeBlock(d!, "Compre%2520Junto", { x: 1 });
    const res = await readFallback(d!, ".deco/blocks.gen.json");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { content: string };
    expect(JSON.parse(body.content)).toEqual({ "Compre Junto": { x: 1 } });
  });

  it("still 400s for a genuinely absent file with no blocks dir", async () => {
    const res = await readFallback(d!, "nope/.deco/blocks.gen.json");
    expect(res.status).toBe(400);
  });

  it("does not synthesize for a non-decofile absent file", async () => {
    const res = await readFallback(d!, "nope.json");
    expect(res.status).toBe(400);
  });
});
