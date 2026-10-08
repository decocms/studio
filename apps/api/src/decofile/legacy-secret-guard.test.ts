/**
 * The content protocol's secret guard on a legacy (v7) site.
 *
 * A v7 `website/loaders/secret.ts` block marks its `encrypted` string
 * `"format": "secret"`, but that string is the site's own hex ciphertext, not
 * a v8 `Secret` field. The guard must let it through unchanged, and stay strict
 * for v8 `Secret` fields and `secret` blocks. The published
 * `@decocms/blocks@8.1.0-next.3` lacks the exemption, so Studio carries it as
 * `patches/@decocms%2Fblocks@8.1.0-next.3.patch` until a release includes it.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContentHandler } from "@decocms/blocks/protocol/server";
import { createFsStorage } from "@decocms/blocks/protocol/storage/fs";

const LOADER = "website/loaders/secret.ts";

/** A v7 `meta.gen.json` with the secret loader, an app that uses it, and a v8 section. */
const meta = {
  manifest: {
    blocks: {
      loaders: { [LOADER]: { $ref: "#/definitions/c2VjcmV0" } },
      apps: { "site/apps/site.ts": { $ref: "#/definitions/c2l0ZQ==" } },
      sections: { newsletter: { $ref: "#/definitions/bmV3c2xldHRlcg==" } },
    },
  },
  schema: {
    definitions: {
      c2VjcmV0: {
        type: "object",
        properties: {
          name: { type: "string" },
          encrypted: { type: "string", format: "secret" },
        },
      },
      "c2l0ZQ==": {
        type: "object",
        properties: { apiKey: { $ref: "#/definitions/c2VjcmV0" } },
      },
      "bmV3c2xldHRlcg==": {
        type: "object",
        properties: { apiKey: { type: "string", format: "secret" } },
      },
    },
  },
};

let root: string;
let handler: (request: Request) => Promise<Response>;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "legacy-secret-guard-"));
  await mkdir(join(root, ".deco", "blocks"), { recursive: true });
  await writeFile(join(root, ".deco", "meta.gen.json"), JSON.stringify(meta));
  handler = createContentHandler(createFsStorage({ root }), {
    server: { name: "test", version: "0" },
  });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function apply(set: Record<string, unknown>) {
  const res = await handler(
    new Request("http://localhost/rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "blocks.apply",
        params: { set },
      }),
    }),
  );
  return (await res.json()) as {
    result?: { revision: string };
    error?: { code: number; message: string };
  };
}

describe("secret guard on a legacy site", () => {
  test("saves a v7 secret loader block's hex ciphertext unchanged", async () => {
    const body = await apply({
      site: {
        __resolveType: "site/apps/site.ts",
        apiKey: {
          __resolveType: LOADER,
          name: "API_KEY",
          encrypted: "0a1b2c3d",
        },
      },
    });
    expect(body.error).toBeUndefined();
    expect(body.result?.revision).toEqual(expect.any(String));
  });

  test("still refuses plain text in a v8 Secret field", async () => {
    const body = await apply({
      news: { __resolveType: "newsletter", apiKey: "plain-text" },
    });
    expect(body.error).toBeDefined();
  });

  test("still refuses a malformed v8 secret block", async () => {
    const body = await apply({
      news: {
        __resolveType: "newsletter",
        apiKey: { __resolveType: "secret", ciphertext: "0a1b2c3d" },
      },
    });
    expect(body.error).toBeDefined();
  });

  test("still refuses a v7 loader block in a v8 Secret field", async () => {
    const body = await apply({
      news: {
        __resolveType: "newsletter",
        apiKey: { __resolveType: LOADER, encrypted: "0a1b2c3d" },
      },
    });
    expect(body.error).toBeDefined();
  });
});
