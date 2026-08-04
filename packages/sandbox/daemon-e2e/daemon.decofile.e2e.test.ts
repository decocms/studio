/**
 * Daemon conformance suite — DECOFILE /read fallback.
 *
 * `.deco/blocks.gen.json` is the runtime's merge of every `.deco/blocks/*.json`;
 * repos commonly gitignore it, so a fresh sandbox has the block sources but not
 * the merged artifact. When the file is absent, GET-equivalent POST /read must
 * synthesize the merge on the fly (keyed by the decoded filename stem) so the
 * CMS is readable before the dev server boots — instead of the plain
 * "File not found" a normal absent file gets. Black-box throughout.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import {
  type Daemon,
  HOOK_TIMEOUT_MS,
  jsonAuthHeaders,
  startDaemon,
  stopDaemon,
  url,
  writeRepoFile,
} from "./daemon.e2e.helpers";

const toBody = (obj: unknown) => JSON.stringify(obj);

// Inlined copy of the web consumer's stripLineNumbers (read-committed-file.ts →
// file-explorer/utils.ts): strips a leading `^\d+\t` from every `\n`-split line.
// The e2e can't import app code (ban-e2e-app-imports), so it owns this contract
// — a divergence from the real consumer is a wire-contract regression signal.
const stripLineNumbers = (content: string): string =>
  content
    .split("\n")
    .map((line) => line.replace(/^\d+\t/, ""))
    .join("\n");

const read = (d: Daemon, path: string) =>
  fetch(url(d, "/_sandbox/read"), {
    method: "POST",
    headers: jsonAuthHeaders(),
    body: toBody({ path, full: true }),
  });

describe("daemon e2e: decofile /read fallback", () => {
  let d: Daemon;
  beforeAll(async () => {
    d = await startDaemon();
  }, HOOK_TIMEOUT_MS);
  afterAll(async () => {
    await stopDaemon(d);
  }, HOOK_TIMEOUT_MS);

  it("synthesizes blocks.gen.json from .deco/blocks/*.json when absent", async () => {
    await writeRepoFile(d, "site-a/.deco/blocks/b.json", `{"n":2}`);
    await writeRepoFile(d, "site-a/.deco/blocks/a.json", `{"n":1}`);

    const res = await read(d, "site-a/.deco/blocks.gen.json");
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
    const hero = JSON.stringify({ title: "Hi", count: 3 }, null, 2);
    const shelf = JSON.stringify({ items: [1, 2] }, null, 2);
    await writeRepoFile(d, "site-pretty/.deco/blocks/hero.json", hero);
    await writeRepoFile(d, "site-pretty/.deco/blocks/shelf.json", shelf);

    const res = await read(d, "site-pretty/.deco/blocks.gen.json");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { content: string };
    expect(body.content).toContain("\n"); // genuinely multi-line
    expect(JSON.parse(stripLineNumbers(body.content))).toEqual({
      hero: { title: "Hi", count: 3 },
      shelf: { items: [1, 2] },
    });
  });

  it("decodes percent-encoded block stems until stable", async () => {
    await writeRepoFile(
      d,
      "site-b/.deco/blocks/Compre%2520Junto.json",
      `{"x":1}`,
    );
    const res = await read(d, "site-b/.deco/blocks.gen.json");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { content: string };
    expect(JSON.parse(body.content)).toEqual({ "Compre Junto": { x: 1 } });
  });

  it("still 400s for a genuinely absent file with no blocks dir", async () => {
    const res = await read(d, "site-c/.deco/blocks.gen.json");
    expect(res.status).toBe(400);
  });

  it("does not synthesize for a non-decofile absent file", async () => {
    const res = await read(d, "site-a/nope.json");
    expect(res.status).toBe(400);
  });
});
