/**
 * Black-box e2e for the content protocol the daemon serves over its working
 * tree: `POST /_sandbox/rpc` and `PUT /_sandbox/assets/<name>`.
 *
 * The daemon's implementation is a Go port of the TypeScript reference in
 * `@decocms/blocks/protocol`. Two things keep the two from drifting:
 *
 *  1. the published conformance suite (`@decocms/blocks/protocol/conformance`,
 *     pinned in package.json) runs against the daemon, with and without a
 *     schema;
 *  2. a parity run sends one request sequence to the daemon and to the
 *     published reference server (`createContentHandler` over
 *     `createFsStorage`) on an identical tree, and requires byte-identical
 *     answers and files.
 *
 * Bumping the pinned `@decocms/blocks` re-runs both against the new contract.
 */
import { afterAll, beforeAll, describe, expect, it, test } from "bun:test";
import { execSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConformanceSuite } from "@decocms/blocks/protocol/conformance";
import { blockFileName, serializeBlock } from "@decocms/blocks/protocol/keys";
import { createContentHandler } from "@decocms/blocks/protocol/server";
import { createFsStorage } from "@decocms/blocks/protocol/storage/fs";
import {
  type Daemon,
  HOOK_TIMEOUT_MS,
  authHeaders,
  readSseUntil,
  startDaemon,
  stopDaemon,
  url,
} from "./daemon.e2e.helpers";

const SERVER = { name: "studio-sandbox-daemon", version: "unknown" };
const LEGACY_SECRET_LOADER = "website/loaders/secret.ts";

/** A deco-meta@1 schema with a Secret field (`newsletter.apiKey`) and the v7 secret loader. */
const schema = {
  blocksMajor: 8,
  manifest: {
    blocks: {
      sections: {
        hero: { $ref: "#/definitions/aGVybw==" },
        newsletter: { $ref: "#/definitions/bmV3c2xldHRlcg==" },
      },
      loaders: {
        multivariate: { $ref: "#/definitions/bXY=" },
        lazy: { $ref: "#/definitions/bGF6eQ==" },
        [LEGACY_SECRET_LOADER]: { $ref: "#/definitions/djc=" },
      },
      content: { settings: { $ref: "#/definitions/c2V0dGluZ3M=" } },
    },
  },
  schema: {
    definitions: {
      "aGVybw==": {
        type: "object",
        properties: {
          title: { type: "string", title: "Heading" },
          padding: { type: "string" },
        },
      },
      "bmV3c2xldHRlcg==": {
        type: "object",
        properties: {
          listId: { type: "string" },
          apiKey: { type: "string", format: "secret", title: "API key" },
        },
      },
      "c2V0dGluZ3M=": {
        type: "object",
        properties: {
          integrations: {
            type: "array",
            items: {
              type: "object",
              properties: {
                token: { $ref: "#/definitions/U2VjcmV0" },
                label: { type: "string" },
              },
            },
          },
          nested: {
            anyOf: [
              {
                type: "object",
                properties: { key: { $ref: "#/definitions/U2VjcmV0" } },
              },
            ],
          },
          extra: {
            type: "object",
            additionalProperties: { $ref: "#/definitions/U2VjcmV0" },
          },
        },
      },
      U2VjcmV0: { type: "string", format: "secret" },
      "bXY=": { type: "object", properties: { variants: { type: "array" } } },
      "bGF6eQ==": { type: "object", properties: { value: {} } },
      "djc=": {
        type: "object",
        properties: {
          name: { type: "string" },
          encrypted: { type: "string", format: "secret" },
        },
      },
    },
  },
};

const publicKeyPem = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
}).publicKey;

/** Lays out an app root the way a v8 site commits it. */
function seedSite(root: string, opts: { schema: boolean }): void {
  mkdirSync(join(root, ".deco", "blocks"), { recursive: true });
  writeFileSync(join(root, ".deco", "index.ts"), "export default {};\n");
  writeFileSync(join(root, ".deco", "secrets.pub"), publicKeyPem);
  if (opts.schema) {
    writeFileSync(
      join(root, ".deco", "schema.gen.json"),
      `${JSON.stringify(schema, null, 2)}\n`,
    );
  }
}

const repoOf = (d: Daemon) => join(d.appDir, "repo");

/** bun:test treats a test function that declares a parameter as callback-style. */
const runner = {
  describe,
  it: (name: string, body: () => Promise<void>, timeout?: number) =>
    it(name, () => body(), timeout),
};

let withSchema: Daemon | null = null;
let withoutSchema: Daemon | null = null;

beforeAll(async () => {
  withSchema = await startDaemon();
  // A git checkout, so the generated-artifact excludes have somewhere to go.
  mkdirSync(repoOf(withSchema), { recursive: true });
  execSync("git init -q", { cwd: repoOf(withSchema) });
  seedSite(repoOf(withSchema), { schema: true });
  withoutSchema = await startDaemon();
  seedSite(repoOf(withoutSchema), { schema: false });
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await stopDaemon(withSchema);
  await stopDaemon(withoutSchema);
}, HOOK_TIMEOUT_MS);

defineConformanceSuite(
  runner,
  () => ({
    endpoint: url(withSchema!, "/_sandbox/rpc"),
    assetsEndpoint: url(withSchema!, "/_sandbox/assets/"),
    headers: authHeaders(),
    secretField: { blockType: "newsletter", field: "apiKey" },
    secretsPublicKey: publicKeyPem,
  }),
  "content protocol conformance (daemon, with a schema)",
);

defineConformanceSuite(
  runner,
  () => ({
    endpoint: url(withoutSchema!, "/_sandbox/rpc"),
    assetsEndpoint: url(withoutSchema!, "/_sandbox/assets/"),
    headers: authHeaders(),
    hasSchema: false,
    secretsPublicKey: publicKeyPem,
  }),
  "content protocol conformance (daemon, without a schema)",
);

async function rpc(d: Daemon, method: string, params?: unknown) {
  const res = await fetch(url(d, "/_sandbox/rpc"), {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      ...(params === undefined ? {} : { params }),
    }),
  });
  return (await res.json()) as {
    result?: any;
    error?: { code: number; message: string; data?: any };
  };
}

describe("daemon content protocol", () => {
  test("requires the daemon token", async () => {
    const res = await fetch(url(withSchema!, "/_sandbox/rpc"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "describe" }),
    });
    expect(res.status).toBe(401);
    const upload = await fetch(url(withSchema!, "/_sandbox/assets/x.png"), {
      method: "PUT",
      headers: { "content-type": "image/png" },
      body: new Uint8Array([1, 2, 3]),
    });
    expect(upload.status).toBe(401);
  });

  test("describe reports the working tree and its upload folder", async () => {
    const { result } = await rpc(withSchema!, "describe");
    expect(result).toMatchObject({
      protocol: "deco-content",
      server: SERVER,
      kind: "working-tree",
      readOnly: false,
      root: ".",
      preview: null,
      assets: {
        dir: "public/assets",
        urlPrefix: "/assets/",
        maxBytes: 25 * 1024 * 1024,
      },
      secrets: { publicKey: publicKeyPem },
    });
  });

  test("writes the bytes the reference serializer writes, versioned as git blobs", async () => {
    const entries: Record<string, unknown> = {
      "content-protocol e2e/Olá 世界": {
        __resolveType: "hero",
        title: "Olá — 世界 😀   <b>&amp;</b>",
        numbers: [
          0, -0, 1e21, 1e-7, 0.1, 123456789012345680000, 5e-324,
          1.7976931348623157e308,
        ],
        "10": "ten",
        "2": "two",
        nested: { b: [], a: {}, z: [{ y: null, x: true }] },
      },
      "content-protocol e2e/50% off": {
        path: "/off",
        control: '\u0000\u001f\t"\\',
      },
    };
    const { result, error } = await rpc(withSchema!, "blocks.apply", {
      set: entries,
    });
    expect(error).toBeUndefined();
    for (const [name, entry] of Object.entries(entries)) {
      const bytes = readFileSync(
        join(repoOf(withSchema!), ".deco", "blocks", blockFileName(name)),
      );
      expect(bytes.toString("utf8")).toBe(serializeBlock(entry));
      const blob = createHash("sha1")
        .update(`blob ${bytes.byteLength}\0`)
        .update(bytes)
        .digest("hex");
      expect(result.versions[name]).toBe(blob);
    }
    await rpc(withSchema!, "blocks.apply", { delete: Object.keys(entries) });
  });

  test("accepts a legacy (v7) secret loader block holding its own ciphertext", async () => {
    const name = "content-protocol-e2e-legacy-secret";
    const { error } = await rpc(withSchema!, "blocks.apply", {
      set: {
        [name]: {
          __resolveType: LEGACY_SECRET_LOADER,
          name: "API_KEY",
          encrypted: "0a1b2c3d",
        },
      },
    });
    expect(error).toBeUndefined();
    const nested = await rpc(withSchema!, "blocks.apply", {
      set: {
        [`${name}-nested`]: {
          __resolveType: "settings",
          integrations: [
            {
              token: {
                __resolveType: LEGACY_SECRET_LOADER,
                name: "K",
                encrypted: "x",
              },
            },
          ],
        },
      },
    });
    // A Secret field still refuses the loader: only `secret` blocks and variants of them qualify.
    expect(nested.error?.code).toBe(-32003);
    await rpc(withSchema!, "blocks.apply", { delete: [name] });
  });

  test("a protocol write updates /_sandbox/decofile and announces it", async () => {
    const before = await fetch(url(withSchema!, "/_sandbox/decofile"));
    await before.text();
    const preVersion = (before.headers.get("etag") ?? "").replace(
      /^W\/"|"$/g,
      "",
    );
    const versionsIn = (acc: string): string[] =>
      [...acc.matchAll(/"version":"([0-9a-f]+)"/g)].map((m) => m[1] ?? "");
    const pending = readSseUntil(url(withSchema!, "/_sandbox/events"), {
      predicate: (acc) =>
        acc.includes("event: file-changed") &&
        versionsIn(acc).some((v) => v !== preVersion),
      deadlineMs: 15_000,
    });
    await new Promise((r) => setTimeout(r, 500));

    const name = "content-protocol-e2e-announce";
    const { error } = await rpc(withSchema!, "blocks.apply", {
      set: { [name]: { title: "hi" } },
    });
    expect(error).toBeUndefined();

    const { text } = await pending;
    expect(text).toContain(`.deco/blocks/${blockFileName(name)}`);
    const after = await fetch(url(withSchema!, "/_sandbox/decofile"));
    const merged = (await after.json()) as Record<string, unknown>;
    expect(merged[name]).toEqual({ title: "hi" });
    expect(after.headers.get("etag")).not.toBe(before.headers.get("etag"));
    await rpc(withSchema!, "blocks.apply", { delete: [name] });
  }, 30_000);

  test("keeps its lock and transaction files out of git", async () => {
    await rpc(withSchema!, "describe");
    const exclude = readFileSync(
      join(repoOf(withSchema!), ".git", "info", "exclude"),
      "utf8",
    );
    expect(exclude.split("\n")).toContain("/.deco/.blocks.lock");
    expect(exclude.split("\n")).toContain("/.deco/.tx-*/");
    const leftovers = readdirSync(join(repoOf(withSchema!), ".deco")).filter(
      (f) => f === ".blocks.lock" || f.startsWith(".tx-"),
    );
    expect(leftovers).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Parity with the reference server
// ---------------------------------------------------------------------------

type Call =
  | {
      kind: "rpc";
      body: string;
      headers?: Record<string, string>;
      method?: string;
    }
  | { kind: "asset"; name: string; type: string; body: Uint8Array };

const req = (method: string, params?: unknown, id: unknown = 1) =>
  JSON.stringify({
    jsonrpc: "2.0",
    id,
    method,
    ...(params === undefined ? {} : { params }),
  });

const CIPHERTEXT = `v1.${Buffer.alloc(384, 7).toString("base64url")}.${Buffer.alloc(12, 1).toString("base64url")}.${Buffer.alloc(32, 2).toString("base64url")}`;
const secret = (ciphertext = CIPHERTEXT) => ({
  __resolveType: "secret",
  ciphertext,
});

/** Every call is sent to both servers in order; answers and trees must match. */
const parityCalls: Call[] = [
  // Wire.
  { kind: "rpc", body: req("describe") },
  { kind: "rpc", body: req("describe", {}, "abc") },
  { kind: "rpc", body: req("describe", {}, 1.5e21) },
  { kind: "rpc", body: "{not json" },
  { kind: "rpc", body: "" },
  { kind: "rpc", body: "[]" },
  { kind: "rpc", body: "null" },
  { kind: "rpc", body: "42" },
  {
    kind: "rpc",
    body: JSON.stringify(
      Array.from({ length: 11 }, (_, i) =>
        JSON.parse(req("describe", undefined, i)),
      ),
    ),
  },
  {
    kind: "rpc",
    body: `[${req("describe", undefined, 1)},${req("nope", {}, 2)},${req("blocks.list", {}, "three")},7]`,
  },
  {
    kind: "rpc",
    body: JSON.stringify({ jsonrpc: "1.0", id: 1, method: "describe" }),
  },
  { kind: "rpc", body: JSON.stringify({ jsonrpc: "2.0", method: "describe" }) },
  {
    kind: "rpc",
    body: JSON.stringify({ jsonrpc: "2.0", id: null, method: "describe" }),
  },
  { kind: "rpc", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: 5 }) },
  {
    kind: "rpc",
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "describe",
      extra: 1,
    }),
  },
  {
    kind: "rpc",
    body: '{"jsonrpc":"2.0","id":1,"method":"describe","__proto__":1}',
  },
  { kind: "rpc", body: req("describe", []) },
  { kind: "rpc", body: req("describe", null) },
  { kind: "rpc", body: req("describe", { a: 1, b: 2 }) },
  { kind: "rpc", body: req("blocks.list", { ifNoneMatch: 5, zz: 1 }) },
  { kind: "rpc", body: req("blocks.list", { ifNoneMatch: [] }) },
  { kind: "rpc", body: req("blocks.list", { ifNoneMatch: "" }) },
  { kind: "rpc", body: req("blocks.list", { ifNoneMatch: "x".repeat(1025) }) },
  {
    kind: "rpc",
    body: req("blocks.apply", {
      set: [],
      delete: [1, "a", null],
      ifMatch: { b: 2, "10": "" },
    }),
  },
  {
    kind: "rpc",
    body: req("blocks.apply", { set: {}, requestKey: "k", ifSchemaMatch: "s" }),
  },
  {
    kind: "rpc",
    body: req("describe"),
    headers: { "content-type": "text/plain" },
  },
  {
    kind: "rpc",
    body: req("describe"),
    headers: { "content-type": "application/json; charset=utf-8" },
  },
  { kind: "rpc", body: req("describe"), method: "GET" },
  { kind: "rpc", body: req("describe"), headers: { "content-encoding": "br" } },
  // Reads.
  { kind: "rpc", body: req("schema.get") },
  { kind: "rpc", body: req("blocks.list") },
  // Writes: bytes, ordering, numbers, unicode.
  {
    kind: "rpc",
    body: req("blocks.apply", {
      set: {
        "pages-Home": {
          __resolveType: "page",
          path: "/",
          sections: [
            {
              __resolveType: "hero",
              title: "Olá — 世界 😀",
              n: [1e21, 1e-7, -0, 0.1, 5e-324],
            },
          ],
          "2": "two",
          "10": "ten",
          b: { y: 1, x: 2 },
        },
        Header: { __resolveType: "header", links: [], empty: {} },
        "pages-Home Page": { path: "/home", s: " \u0000<>&" },
        "50% off": { v: 1 },
        "7": { numeric: true },
      },
    }),
  },
  { kind: "rpc", body: req("blocks.list") },
  // Lone surrogates survive a round trip.
  {
    kind: "rpc",
    body: '{"jsonrpc":"2.0","id":1,"method":"blocks.apply","params":{"set":{"lone":{"s":"\\ud800x\\udfff","\\udbff":"\\ud83d\\ude00"}}}}',
  },
  // A lone surrogate in a name can't be encoded: an Internal error, as URIError is in JS.
  {
    kind: "rpc",
    body: '{"jsonrpc":"2.0","id":1,"method":"blocks.apply","params":{"set":{"bad\\ud800":{}}}}',
  },
  // Validation: names, shapes, spelling collisions, case collisions.
  {
    kind: "rpc",
    body: req("blocks.apply", {
      set: {
        "": { x: 1 },
        "a\\b": { x: 1 },
        "a..b": { x: 1 },
        ".hidden": { x: 1 },
        __proto__x: { x: 1 },
        CON: { x: 1 },
        "nul.backup": { x: 1 },
        "widget.TSX": { x: 1 },
        ["é".repeat(42)]: { x: 1 },
        arr: [],
        nul: null,
        "Home%20Page": { v: 1 },
        "Home Page": { v: 2 },
      },
      delete: ["", "keep.ts"],
    }),
  },
  {
    kind: "rpc",
    body: '{"jsonrpc":"2.0","id":1,"method":"blocks.apply","params":{"set":{"__proto__":{"x":1}}}}',
  },
  { kind: "rpc", body: req("blocks.apply", { set: { header: { v: 2 } } }) },
  {
    kind: "rpc",
    body: req("blocks.apply", {
      set: { big: { text: "x".repeat(1024 * 1024) } },
    }),
  },
  // The secret guard.
  {
    kind: "rpc",
    body: req("blocks.apply", {
      set: {
        n1: { __resolveType: "newsletter", listId: "l", apiKey: "hunter2" },
        n2: { __resolveType: "newsletter", apiKey: secret("v1.QUJD.ZGVm") },
        n3: {
          __resolveType: "settings",
          integrations: [{ token: secret(), label: "ok" }, { token: "plain" }],
          nested: { key: "plain" },
          extra: { a: secret(), b: "plain", constructor: "plain" },
        },
        n4: {
          __resolveType: "newsletter",
          apiKey: {
            __resolveType: "multivariate",
            variants: [
              {
                rule: { __resolveType: "always" },
                value: { __resolveType: "lazy", value: secret() },
              },
              { value: "plain" },
              7,
            ],
          },
        },
        n5: { __resolveType: "hero", title: secret("bad"), list: [secret()] },
        n6: {
          __resolveType: LEGACY_SECRET_LOADER,
          name: "K",
          encrypted: "0a1b",
        },
      },
    }),
  },
  {
    kind: "rpc",
    body: req("blocks.apply", {
      set: {
        ok: { __resolveType: "newsletter", apiKey: secret() },
        legacy: {
          __resolveType: LEGACY_SECRET_LOADER,
          name: "K",
          encrypted: "0a1b",
        },
      },
    }),
  },
  // Spellings, guards, deletes.
  {
    kind: "rpc",
    body: req("blocks.apply", {
      set: { "Home Page": { v: 3 } },
      ifMatch: { "Home Page": null },
    }),
  },
  {
    kind: "rpc",
    body: req("blocks.apply", { set: { "pages-Home%20Page": { v: 3 } } }),
  },
  { kind: "rpc", body: req("blocks.list") },
  {
    kind: "rpc",
    body: req("blocks.apply", {
      set: { "pages-Home Page": { path: "/home", v: 4 } },
    }),
  },
  {
    kind: "rpc",
    body: req("blocks.apply", {
      set: { x: { v: 1 } },
      ifMatch: { Header: "nope", missing: null, other: "v" },
    }),
  },
  {
    kind: "rpc",
    body: '{"jsonrpc":"2.0","id":1,"method":"blocks.apply","params":{"delete":["x"],"ifMatch":{"__proto__":5}}}',
  },
  {
    kind: "rpc",
    body: req("blocks.apply", {
      delete: ["50% off", "50% off", "gone", "7"],
      set: { gone: { back: true } },
    }),
  },
  {
    kind: "rpc",
    body: req("blocks.apply", {
      delete: Array.from({ length: 501 }, (_, i) => `d${i}`),
    }),
  },
  { kind: "rpc", body: req("blocks.apply", { delete: ["never-existed"] }) },
  { kind: "rpc", body: req("blocks.list") },
  {
    kind: "rpc",
    body: req("blocks.list"),
    headers: { "accept-encoding": "gzip" },
  },
  // Uploads.
  {
    kind: "asset",
    name: "Bänner (1).PNG",
    type: "image/png",
    body: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
  },
  {
    kind: "asset",
    name: "logo",
    type: "image/webp; charset=x",
    body: new Uint8Array([1]),
  },
  {
    kind: "asset",
    name: "evil.html",
    type: "image/png",
    body: new Uint8Array([1]),
  },
  {
    kind: "asset",
    name: "logo.svg",
    type: "image/svg+xml",
    body: new Uint8Array([1]),
  },
  {
    kind: "asset",
    name: "empty.png",
    type: "image/png",
    body: new Uint8Array([]),
  },
  { kind: "asset", name: "...", type: "image/png", body: new Uint8Array([1]) },
];

/**
 * Status, the headers the protocol fixes, and the body. `fetch` decompresses
 * the daemon's gzip answers; the in-process reference's are decompressed here.
 */
async function snapshotResponse(res: Response, inProcess: boolean) {
  const headers = [
    "content-type",
    "cache-control",
    "vary",
    "allow",
    "content-encoding",
  ].map((h) => `${h}: ${res.headers.get(h)}`);
  let bytes = new Uint8Array(await res.arrayBuffer());
  if (inProcess && res.headers.get("content-encoding") === "gzip")
    bytes = Bun.gunzipSync(bytes);
  return { status: res.status, headers, body: new TextDecoder().decode(bytes) };
}

function treeOf(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string, rel: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const path = join(dir, entry.name);
      const key = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path, key);
      else out[key] = readFileSync(path).toString("base64");
    }
  };
  walk(root, "");
  return out;
}

describe("parity with the reference server (@decocms/blocks/protocol)", () => {
  let daemon: Daemon | null = null;
  let refRoot = "";

  beforeAll(async () => {
    daemon = await startDaemon();
    seedSite(repoOf(daemon), { schema: true });
    refRoot = mkdtempSync(join(tmpdir(), "content-protocol-ref-"));
    seedSite(refRoot, { schema: true });
  }, HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await stopDaemon(daemon);
    if (refRoot) rmSync(refRoot, { recursive: true, force: true });
  }, HOOK_TIMEOUT_MS);

  test("answers and writes byte for byte what the reference does", async () => {
    const storage = createFsStorage({ root: refRoot, repoRoot: refRoot });
    const reference = createContentHandler(storage, { server: SERVER });
    // Not a public export: the module `deco serve` mounts for uploads.
    const { createAssetHandler } = await import(
      new URL(
        "./assets.js",
        import.meta.resolve("@decocms/blocks/protocol/server"),
      ).href
    );
    const referenceAssets = createAssetHandler(storage);

    for (const [index, call] of parityCalls.entries()) {
      let ours: Response;
      let theirs: Response;
      if (call.kind === "rpc") {
        const method = call.method ?? "POST";
        const init = (base: Record<string, string>) => ({
          method,
          // fetch asks for gzip unless told otherwise; both sides get the same header.
          headers: {
            "content-type": "application/json",
            "accept-encoding": "identity",
            ...base,
            ...call.headers,
          },
          body: method === "GET" ? undefined : call.body,
        });
        ours = await fetch(url(daemon!, "/_sandbox/rpc"), init(authHeaders()));
        theirs = await reference(new Request("http://reference/rpc", init({})));
      } else {
        const path = `/assets/${encodeURIComponent(call.name)}`;
        const init = (base: Record<string, string>) => ({
          method: "PUT",
          headers: {
            ...base,
            "accept-encoding": "identity",
            "content-type": call.type,
          },
          body: call.body,
        });
        ours = await fetch(
          url(daemon!, `/_sandbox${path}`),
          init(authHeaders()),
        );
        theirs = await referenceAssets(
          new Request(`http://reference${path}`, init({})),
        );
      }
      const label = `call #${index}: ${call.kind === "rpc" ? call.body.slice(0, 120) : call.name}`;
      expect({ label, ...(await snapshotResponse(ours, false)) }).toEqual({
        label,
        ...(await snapshotResponse(theirs, true)),
      });
    }
    const tree = treeOf(repoOf(daemon!));
    expect(tree).toEqual(treeOf(refRoot));
    // The sequence really wrote: a guard against comparing two empty trees.
    expect(Object.keys(tree)).toEqual(
      expect.arrayContaining([
        ".deco/blocks/pages-Home.json",
        ".deco/blocks/lone.json",
        ".deco/blocks/legacy.json",
        "public/assets/Banner-1.png",
        "public/assets/logo.webp",
      ]),
    );
  }, 120_000);
});
