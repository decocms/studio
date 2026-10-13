/**
 * The content-protocol suites a sandbox session must pass, run by the unit
 * test (`content-storage.test.ts`, over an in-process stand-in for the
 * daemon's file routes) and by the daemon e2e (`content-storage.daemon.e2e.test.ts`,
 * over the real Go daemon built from `packages/sandbox`).
 *
 * Both drive the real route (`serveSandboxContent` behind a claim like
 * `resolveVmClaim` sets), so what is proven is what the editor talks to:
 *
 *  1. the published conformance suite (`@decocms/blocks/protocol/conformance`),
 *     with and without a schema;
 *  2. a parity run: one request sequence sent to the sandbox route and to the
 *     reference server (`createContentHandler` over `createFsStorage`) on an
 *     identical tree must give byte-identical answers and files;
 *  3. the sandbox's own promises (describe, git-blob versions, edits made
 *     beside the editor, conflicts).
 */

import { afterAll, beforeAll, describe, expect, it, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { Hono, type Context } from "hono";
import { defineConformanceSuite } from "@decocms/blocks/protocol/conformance";
import { blockFileName, serializeBlock } from "@decocms/blocks/protocol/keys";
import { createContentHandler } from "@decocms/blocks/protocol/server";
import { createFsStorage } from "@decocms/blocks/protocol/storage/fs";
import { serveSandboxContent } from "../api/routes/sandbox-proxy";
import { SANDBOX_CONTENT_SERVER } from "./content-storage";

/** `SandboxProvider.proxyDaemonRequest`, as the route calls it. */
export type ProxyDaemonRequest = (
  claimName: string,
  path: string,
  init: RequestInit & { headers: Headers },
) => Promise<Response>;

/** A sandbox under test: its repository folder and how to reach its daemon. */
export interface SandboxUnderTest {
  repoDir: string;
  proxyDaemonRequest: ProxyDaemonRequest;
}

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
export function seedSite(root: string, opts: { schema: boolean }): void {
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

// ---------------------------------------------------------------------------
// The route under test
// ---------------------------------------------------------------------------

type VmContext = Parameters<typeof serveSandboxContent>[0];

let claims = 0;

/**
 * `POST /:virtualMcpId/:branch/rpc` behind a sandbox claim, as Studio mounts
 * it. Each call is a new claim, so no two sandboxes share warm state.
 */
export function sandboxRoute(
  sandbox: () => SandboxUnderTest,
  options: { packagePath?: string } = {},
) {
  const claimName = `claim-${++claims}`;
  const hono = new Hono();
  hono.use("/:virtualMcpId/:branch/*", async (c, next) => {
    (c as unknown as Context).set("vmClaim", {
      claimName,
      callerUserId: "u1",
      runner: { proxyDaemonRequest: sandbox().proxyDaemonRequest },
      virtualMcpId: c.req.param("virtualMcpId"),
      branch: c.req.param("branch"),
      userId: "u1",
      projectRef: "p1",
      virtualMcpMetadata: options.packagePath
        ? { runtime: { path: options.packagePath } }
        : null,
      connectionIds: [],
      runtime: "sandbox",
    });
    await next();
  });
  hono.all("/:virtualMcpId/:branch/rpc", (c) =>
    serveSandboxContent(c as unknown as VmContext),
  );
  const endpoint = "http://studio.test/vm1/main/rpc";
  return {
    endpoint,
    fetch: (request: Request) => Promise.resolve(hono.fetch(request)),
  };
}

export async function rpc(
  route: ReturnType<typeof sandboxRoute>,
  method: string,
  params?: unknown,
) {
  const res = await route.fetch(
    new Request(route.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        ...(params === undefined ? {} : { params }),
      }),
    }),
  );
  // biome-ignore lint/suspicious/noExplicitAny: protocol results are asserted per test
  return (await res.json()) as { result?: any; error?: any };
}

// ---------------------------------------------------------------------------
// An in-process stand-in for the daemon's file routes
// ---------------------------------------------------------------------------

const BLOCK_PATH = /(^|\/)\.deco\/blocks\/.+\.json$/i;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/**
 * `/_sandbox/{read,write,unlink,bash}` over `repoDir`, answering what the Go
 * daemon answers (packages/sandbox/daemon-go/internal/routes/fs.go, bash.go):
 * `read` numbers every line, `write` refuses an invalid block JSON, `unlink`
 * reports whether the file existed, `bash` runs in the repository.
 */
export function fakeDaemon(
  repoDir: string,
  hooks: { beforeWrite?: (path: string) => void } = {},
): ProxyDaemonRequest {
  const inside = (path: string) => {
    const abs = resolve(repoDir, path);
    return relative(repoDir, abs).startsWith("..") ? null : abs;
  };
  return async (_claim, path, init) => {
    const body = JSON.parse(String(init.body ?? "{}"));
    switch (path) {
      case "/_sandbox/read": {
        const abs = inside(body.path);
        if (!abs) return json(400, { error: "Path escapes project root" });
        if (!existsSync(abs)) {
          return json(400, { error: `File not found: ${body.path}` });
        }
        if (statSync(abs).isDirectory()) {
          return json(400, { error: "Path is a directory" });
        }
        const lines = readFileSync(abs, "utf8").split("\n");
        return json(200, {
          kind: "text",
          content: lines.map((line, i) => `${i + 1}\t${line}`).join("\n"),
          lineCount: lines.length,
        });
      }
      case "/_sandbox/write": {
        const abs = inside(body.path);
        if (!abs) return json(400, { error: "Path escapes app root" });
        if (BLOCK_PATH.test(body.path)) {
          try {
            JSON.parse(body.content);
          } catch (error) {
            return json(400, { error: `Refusing to write invalid JSON` });
          }
        }
        hooks.beforeWrite?.(body.path);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, body.content);
        return json(200, { ok: true, bytesWritten: body.content.length });
      }
      case "/_sandbox/unlink": {
        const abs = inside(body.path);
        if (!abs) return json(400, { error: "Path escapes app root" });
        const existed = existsSync(abs);
        if (existed) unlinkSync(abs);
        return json(200, { ok: true, existed });
      }
      case "/_sandbox/bash": {
        const run = spawnSync("bash", ["-c", body.command], {
          cwd: repoDir,
          encoding: "utf8",
        });
        return json(200, {
          stdout: run.stdout,
          stderr: run.stderr,
          exitCode: run.status ?? -1,
          timedOut: false,
          truncated: false,
        });
      }
      default:
        return json(404, { error: `Not found: ${path}` });
    }
  };
}

// ---------------------------------------------------------------------------
// The suites
// ---------------------------------------------------------------------------

/** bun:test treats a test function that declares a parameter as callback-style. */
const runner = {
  describe,
  it: (name: string, body: () => Promise<void>, timeout?: number) =>
    it(name, () => body(), timeout),
};

const blob = (bytes: Uint8Array) =>
  createHash("sha1")
    .update(`blob ${bytes.byteLength}\0`)
    .update(bytes)
    .digest("hex");

/**
 * Registers every suite. `start` gives a fresh sandbox whose repository is
 * empty; `stop` releases it.
 */
export function defineSandboxContentSuites(
  label: string,
  start: () => Promise<SandboxUnderTest>,
  stop: (sandbox: SandboxUnderTest) => Promise<void>,
  timeoutMs = 30_000,
) {
  let withSchema: SandboxUnderTest | null = null;
  let withoutSchema: SandboxUnderTest | null = null;
  const withSchemaRoute = sandboxRoute(() => withSchema!);
  const withoutSchemaRoute = sandboxRoute(() => withoutSchema!);

  beforeAll(async () => {
    withSchema = await start();
    spawnSync("git", ["init", "-q"], { cwd: withSchema.repoDir });
    seedSite(withSchema.repoDir, { schema: true });
    withoutSchema = await start();
    seedSite(withoutSchema.repoDir, { schema: false });
  }, timeoutMs);

  afterAll(async () => {
    if (withSchema) await stop(withSchema);
    if (withoutSchema) await stop(withoutSchema);
  }, timeoutMs);

  defineConformanceSuite(
    runner,
    () => ({
      endpoint: withSchemaRoute.endpoint,
      fetch: withSchemaRoute.fetch,
      secretField: { blockType: "newsletter", field: "apiKey" },
      secretsPublicKey: publicKeyPem,
    }),
    `content protocol conformance (${label}, with a schema)`,
  );

  defineConformanceSuite(
    runner,
    () => ({
      endpoint: withoutSchemaRoute.endpoint,
      fetch: withoutSchemaRoute.fetch,
      hasSchema: false,
      secretsPublicKey: publicKeyPem,
    }),
    `content protocol conformance (${label}, without a schema)`,
  );

  describe(`sandbox content protocol (${label})`, () => {
    test("describe reports the working tree and no upload folder", async () => {
      const { result } = await rpc(withSchemaRoute, "describe");
      expect(result).toMatchObject({
        protocol: "deco-content",
        server: SANDBOX_CONTENT_SERVER,
        kind: "working-tree",
        readOnly: false,
        root: ".",
        preview: null,
        assets: null,
        secrets: { publicKey: publicKeyPem },
      });
    });

    test("writes the bytes the reference serializer writes, versioned as git blobs", async () => {
      const entries: Record<string, unknown> = {
        "content-protocol e2e/Olá 世界": {
          __resolveType: "hero",
          title: "Olá — 世界 😀   <b>&amp;</b>",
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
      const { result, error } = await rpc(withSchemaRoute, "blocks.apply", {
        set: entries,
      });
      expect(error).toBeUndefined();
      for (const [name, entry] of Object.entries(entries)) {
        const bytes = readFileSync(
          join(withSchema!.repoDir, ".deco", "blocks", blockFileName(name)),
        );
        expect(bytes.toString("utf8")).toBe(serializeBlock(entry));
        expect(result.versions[name]).toBe(blob(bytes));
      }
      await rpc(withSchemaRoute, "blocks.apply", {
        delete: Object.keys(entries),
      });
    });

    test("accepts a legacy (v7) secret loader block holding its own ciphertext", async () => {
      const name = "content-protocol-e2e-legacy-secret";
      const { error } = await rpc(withSchemaRoute, "blocks.apply", {
        set: {
          [name]: {
            __resolveType: LEGACY_SECRET_LOADER,
            name: "API_KEY",
            encrypted: "0a1b2c3d",
          },
        },
      });
      expect(error).toBeUndefined();
      const nested = await rpc(withSchemaRoute, "blocks.apply", {
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
      await rpc(withSchemaRoute, "blocks.apply", { delete: [name] });
    });

    test("sees edits made beside the editor (the agent, a terminal)", async () => {
      const file = join(withSchema!.repoDir, ".deco", "blocks", "beside.json");
      /** Polls as the editor does until `done` holds for the listing. */
      const pollUntil = async (
        // biome-ignore lint/suspicious/noExplicitAny: a protocol result
        done: (result: any) => boolean,
      ) => {
        for (let i = 0; i < 40; i++) {
          const { result } = await rpc(withSchemaRoute, "blocks.list");
          if (done(result)) return result;
          await new Promise((r) => setTimeout(r, 50));
        }
        throw new Error("the edit never showed");
      };
      writeFileSync(file, '{"v":1}\n');
      const first = await pollUntil((r) => r.blocks.beside !== undefined);
      expect(first.blocks.beside).toEqual({ v: 1 });
      expect(first.versions.beside).toBe(blob(readFileSync(file)));
      // Same size, new bytes: still a new version.
      writeFileSync(file, '{"v":2}\n');
      await pollUntil((r) => r.blocks.beside?.v === 2);
      unlinkSync(file);
      await pollUntil((r) => r.blocks.beside === undefined);
    });

    test("a save over an edit made beside the editor is a Conflict, and writes nothing", async () => {
      const file = join(withSchema!.repoDir, ".deco", "blocks", "raced.json");
      const saved = await rpc(withSchemaRoute, "blocks.apply", {
        set: { raced: { v: 1 } },
      });
      const version = saved.result.versions.raced;
      writeFileSync(file, '{"v":"agent"}');
      const conflict = await rpc(withSchemaRoute, "blocks.apply", {
        set: { raced: { v: 2 } },
        ifMatch: { raced: version },
      });
      expect(conflict.error?.data?.entries?.raced?.expected).toBe(version);
      expect(readFileSync(file, "utf8")).toBe('{"v":"agent"}');
      await rpc(withSchemaRoute, "blocks.apply", { delete: ["raced"] });
    });

    test("leaves nothing in .deco but the blocks it wrote", async () => {
      await rpc(withSchemaRoute, "blocks.apply", { set: { tidy: { v: 1 } } });
      await rpc(withSchemaRoute, "blocks.apply", { delete: ["tidy"] });
      const left = readdirSync(join(withSchema!.repoDir, ".deco")).sort();
      expect(left).toEqual([
        "blocks",
        "index.ts",
        "schema.gen.json",
        "secrets.pub",
      ]);
    });
  });

  describe(`sandbox content protocol under an app root (${label})`, () => {
    let sandbox: SandboxUnderTest | null = null;
    const route = sandboxRoute(() => sandbox!, { packagePath: "apps/site" });

    beforeAll(async () => {
      sandbox = await start();
      seedSite(join(sandbox.repoDir, "apps", "site"), { schema: true });
    }, timeoutMs);
    afterAll(async () => {
      if (sandbox) await stop(sandbox);
    }, timeoutMs);

    test("reads and writes `<app root>/.deco`", async () => {
      const described = await rpc(route, "describe");
      expect(described.result.root).toBe("apps/site");
      const schemaRead = await rpc(route, "schema.get");
      expect(schemaRead.result.schema).toMatchObject({ blocksMajor: 8 });
      await rpc(route, "blocks.apply", { set: { Home: { path: "/" } } });
      expect(
        readFileSync(
          join(
            sandbox!.repoDir,
            "apps",
            "site",
            ".deco",
            "blocks",
            "Home.json",
          ),
          "utf8",
        ),
      ).toBe(serializeBlock({ path: "/" }));
    });
  });

  describe(`sandbox content protocol without a .deco folder (${label})`, () => {
    let sandbox: SandboxUnderTest | null = null;
    const route = sandboxRoute(() => sandbox!);
    beforeAll(async () => {
      sandbox = await start();
      mkdirSync(sandbox.repoDir, { recursive: true });
    }, timeoutMs);
    afterAll(async () => {
      if (sandbox) await stop(sandbox);
    }, timeoutMs);

    test("reads as NotFound, as a deco serve does", async () => {
      const schemaRead = await rpc(route, "schema.get");
      expect(schemaRead.error?.code).toBe(-32001);
      const listed = await rpc(route, "blocks.list");
      expect(listed.error?.code).toBe(-32001);
    });
  });

  defineParitySuite(label, start, stop, timeoutMs);
}

// ---------------------------------------------------------------------------
// Parity with the reference server
// ---------------------------------------------------------------------------

type Call = {
  body: string;
  headers?: Record<string, string>;
  method?: string;
};

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
  { body: req("describe") },
  { body: req("describe", {}, "abc") },
  { body: req("describe", {}, 1.5e21) },
  { body: "{not json" },
  { body: "" },
  { body: "[]" },
  { body: "null" },
  { body: "42" },
  {
    body: JSON.stringify(
      Array.from({ length: 11 }, (_, i) =>
        JSON.parse(req("describe", undefined, i)),
      ),
    ),
  },
  {
    body: `[${req("describe", undefined, 1)},${req("nope", {}, 2)},${req("blocks.list", {}, "three")},7]`,
  },
  { body: JSON.stringify({ jsonrpc: "1.0", id: 1, method: "describe" }) },
  { body: JSON.stringify({ jsonrpc: "2.0", method: "describe" }) },
  { body: JSON.stringify({ jsonrpc: "2.0", id: null, method: "describe" }) },
  { body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: 5 }) },
  {
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "describe",
      extra: 1,
    }),
  },
  { body: '{"jsonrpc":"2.0","id":1,"method":"describe","__proto__":1}' },
  { body: req("describe", []) },
  { body: req("describe", null) },
  { body: req("describe", { a: 1, b: 2 }) },
  { body: req("blocks.list", { ifNoneMatch: 5, zz: 1 }) },
  { body: req("blocks.list", { ifNoneMatch: [] }) },
  { body: req("blocks.list", { ifNoneMatch: "" }) },
  { body: req("blocks.list", { ifNoneMatch: "x".repeat(1025) }) },
  {
    body: req("blocks.apply", {
      set: [],
      delete: [1, "a", null],
      ifMatch: { b: 2, "10": "" },
    }),
  },
  {
    body: req("blocks.apply", { set: {}, requestKey: "k", ifSchemaMatch: "s" }),
  },
  { body: req("describe"), headers: { "content-type": "text/plain" } },
  {
    body: req("describe"),
    headers: { "content-type": "application/json; charset=utf-8" },
  },
  { body: req("describe"), method: "GET" },
  { body: req("describe"), headers: { "content-encoding": "br" } },
  // Reads.
  { body: req("schema.get") },
  { body: req("blocks.list") },
  // Writes: bytes, ordering, numbers, unicode.
  {
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
        "pages-Home Page": { path: "/home", s: " \u0000<>&" },
        "50% off": { v: 1 },
        "7": { numeric: true },
      },
    }),
  },
  { body: req("blocks.list") },
  // Lone surrogates survive a round trip.
  {
    body: '{"jsonrpc":"2.0","id":1,"method":"blocks.apply","params":{"set":{"lone":{"s":"\\ud800x\\udfff","\\udbff":"\\ud83d\\ude00"}}}}',
  },
  // A lone surrogate in a name can't be encoded: an Internal error, as URIError is in JS.
  {
    body: '{"jsonrpc":"2.0","id":1,"method":"blocks.apply","params":{"set":{"bad\\ud800":{}}}}',
  },
  // Validation: names, shapes, spelling collisions, case collisions.
  {
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
    body: '{"jsonrpc":"2.0","id":1,"method":"blocks.apply","params":{"set":{"__proto__":{"x":1}}}}',
  },
  { body: req("blocks.apply", { set: { header: { v: 2 } } }) },
  {
    body: req("blocks.apply", {
      set: { big: { text: "x".repeat(1024 * 1024) } },
    }),
  },
  // The secret guard.
  {
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
    body: req("blocks.apply", {
      set: { "Home Page": { v: 3 } },
      ifMatch: { "Home Page": null },
    }),
  },
  { body: req("blocks.apply", { set: { "pages-Home%20Page": { v: 3 } } }) },
  { body: req("blocks.list") },
  {
    body: req("blocks.apply", {
      set: { "pages-Home Page": { path: "/home", v: 4 } },
    }),
  },
  {
    body: req("blocks.apply", {
      set: { x: { v: 1 } },
      ifMatch: { Header: "nope", missing: null, other: "v" },
    }),
  },
  {
    body: '{"jsonrpc":"2.0","id":1,"method":"blocks.apply","params":{"delete":["x"],"ifMatch":{"__proto__":5}}}',
  },
  {
    body: req("blocks.apply", {
      delete: ["50% off", "50% off", "gone", "7"],
      set: { gone: { back: true } },
    }),
  },
  {
    body: req("blocks.apply", {
      delete: Array.from({ length: 501 }, (_, i) => `d${i}`),
    }),
  },
  { body: req("blocks.apply", { delete: ["never-existed"] }) },
  { body: req("blocks.list") },
  { body: req("blocks.list"), headers: { "accept-encoding": "gzip" } },
];

/** Status, the headers the protocol fixes, and the (decompressed) body. */
async function snapshotResponse(res: Response) {
  const headers = [
    "content-type",
    "cache-control",
    "vary",
    "allow",
    "content-encoding",
  ].map((h) => `${h}: ${res.headers.get(h)}`);
  let bytes = new Uint8Array(await res.arrayBuffer());
  if (res.headers.get("content-encoding") === "gzip") {
    bytes = Bun.gunzipSync(bytes);
  }
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

function defineParitySuite(
  label: string,
  start: () => Promise<SandboxUnderTest>,
  stop: (sandbox: SandboxUnderTest) => Promise<void>,
  timeoutMs: number,
) {
  describe(`parity with the reference server (${label})`, () => {
    let sandbox: SandboxUnderTest | null = null;
    let refRoot = "";
    const route = sandboxRoute(() => sandbox!);

    beforeAll(async () => {
      sandbox = await start();
      seedSite(sandbox.repoDir, { schema: true });
      refRoot = mkdtempSync(join(tmpdir(), "content-protocol-ref-"));
      seedSite(refRoot, { schema: true });
    }, timeoutMs);

    afterAll(async () => {
      if (sandbox) await stop(sandbox);
      if (refRoot) rmSync(refRoot, { recursive: true, force: true });
    }, timeoutMs);

    test("answers and writes byte for byte what the reference does", async () => {
      const fsStorage = createFsStorage({ root: refRoot, repoRoot: refRoot });
      // Sandboxes take no uploads (assets live in Studio's file storage).
      const reference = createContentHandler(
        {
          ...fsStorage,
          describe: async () => ({
            ...(await fsStorage.describe()),
            assets: null,
          }),
        },
        { server: SANDBOX_CONTENT_SERVER },
      );

      for (const [index, call] of parityCalls.entries()) {
        const method = call.method ?? "POST";
        const init = () => ({
          method,
          headers: {
            "content-type": "application/json",
            "accept-encoding": "identity",
            ...call.headers,
          },
          body: method === "GET" ? undefined : call.body,
        });
        const ours = await route.fetch(new Request(route.endpoint, init()));
        const theirs = await reference(
          new Request("http://reference/rpc", init()),
        );
        const label = `call #${index}: ${call.body.slice(0, 120)}`;
        expect({ label, ...(await snapshotResponse(ours)) }).toEqual({
          label,
          ...(await snapshotResponse(theirs)),
        });
      }
      const tree = treeOf(sandbox!.repoDir);
      expect(tree).toEqual(treeOf(refRoot));
      // The sequence really wrote: a guard against comparing two empty trees.
      expect(Object.keys(tree)).toEqual(
        expect.arrayContaining([
          ".deco/blocks/pages-Home.json",
          ".deco/blocks/lone.json",
          ".deco/blocks/legacy.json",
        ]),
      );
    }, 120_000);
  });
}
