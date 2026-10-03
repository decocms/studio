/**
 * `describe`, `schema.get` and `blocks.list`, including conditional reads.
 */
import { ErrorCode } from "../../errors";
import { PROTOCOL_NAME, SCHEMA_FORMAT } from "../../types";
import { assert, assertEqual, expectError } from "../context";
import type { ConformanceCase } from "./types";

const LIMIT_KEYS = [
  "maxOpsPerApply",
  "maxBlockBytes",
  "maxRequestBytes",
  "maxListBytes",
  "maxSchemaBytes",
  "maxBatchResponseBytes",
] as const;

export const readCases: ConformanceCase[] = [
  {
    id: "describe/shape",
    title:
      "describe reports the protocol, its version, kind, root, limits and features",
    async run(ctx) {
      const d = await ctx.client.describe();
      assertEqual(d.protocol, PROTOCOL_NAME, "protocol");
      assertEqual(d.version.major, 1, "version.major");
      assert(
        Number.isInteger(d.version.minor) && d.version.minor >= 0,
        "version.minor",
      );
      assert(
        typeof d.server?.name === "string" &&
          typeof d.server?.version === "string",
        "server",
      );
      assert(
        d.kind === "working-tree" || d.kind === "git",
        `kind ${String(d.kind)}`,
      );
      assert(typeof d.readOnly === "boolean", "readOnly");
      assert(
        typeof d.root === "string" && !d.root.startsWith("/"),
        "root is relative",
      );
      assertEqual(d.schemaFormat, SCHEMA_FORMAT, "schemaFormat");
      assert(d.refs === null || typeof d.refs.default === "string", "refs");
      assert(
        d.writes.idempotency === null || d.writes.idempotency.retentionMs > 0,
        "writes.idempotency",
      );
      assert(
        typeof d.writes.schemaPreconditions === "boolean",
        "writes.schemaPreconditions",
      );
      assert(d.pollIntervalMs > 0, "pollIntervalMs");
      for (const key of LIMIT_KEYS) assert(d.limits[key] > 0, `limits.${key}`);
      assert(
        d.preview === null || /^https?:\/\//.test(String(d.preview?.url)),
        "preview is null or { url } with an http(s) URL",
      );
      if (d.readOnly)
        assertEqual(d.assets, null, "assets is null when read-only");
      if (d.assets) {
        assertEqual(d.assets.urlPrefix, "/assets/", "assets.urlPrefix");
        assert(
          d.assets.maxBytes > 0 && typeof d.assets.dir === "string",
          "assets",
        );
      }
      assert(
        d.secrets === null || typeof d.secrets.publicKey === "string",
        "secrets",
      );
    },
  },
  {
    id: "describe/secrets",
    title: "describe returns the committed public key for secrets",
    async run(ctx) {
      const expected = ctx.options.secretsPublicKey;
      if (expected === undefined)
        return ctx.skip("no secretsPublicKey fixture");
      const d = await ctx.client.describe();
      assertEqual(d.secrets, { publicKey: expected }, "describe.secrets");
    },
  },
  {
    id: "schema/read",
    title:
      "schema.get returns the schema and a version, and 'not modified' for that version",
    async run(ctx) {
      if (ctx.options.hasSchema === false) {
        await expectError(
          ctx.client.schemaGet(),
          ErrorCode.NotFound,
          "no schema",
        );
        return;
      }
      const first = await ctx.client.schemaGet();
      assert(!first.notModified, "the first read returns the schema");
      assert(
        typeof first.version === "string" && first.version.length > 0,
        "a version",
      );
      assert(
        typeof first.schema === "object" && first.schema !== null,
        "a schema object",
      );
      const again = await ctx.client.schemaGet({ ifNoneMatch: first.version });
      assertEqual(
        again,
        { notModified: true, version: first.version },
        "the conditional read",
      );
      const stale = await ctx.client.schemaGet({
        ifNoneMatch: `${first.version}-stale`,
      });
      assert(!stale.notModified, "another version returns the schema");
    },
  },
  {
    id: "list/read",
    title:
      "blocks.list returns every entry with versions, and 'not modified' for its revision",
    async run(ctx) {
      const first = await ctx.client.blocksList();
      assert(!first.notModified, "the first read returns the map");
      assert(
        typeof first.revision === "string" && first.revision.length > 0,
        "a revision",
      );
      assert(Array.isArray(first.diagnostics), "diagnostics");
      assertEqual(
        Object.keys(first.versions).sort(),
        Object.keys(first.blocks).sort(),
        "one version per entry",
      );
      const d = await ctx.describe();
      if (d.refs === null)
        assertEqual(first.resolvedRef, null, "resolvedRef without refs");
      const again = await ctx.client.blocksList({
        ifNoneMatch: first.revision,
      });
      assertEqual(
        again,
        {
          notModified: true,
          revision: first.revision,
          resolvedRef: first.resolvedRef,
        },
        "the conditional read",
      );
    },
  },
  {
    id: "list/poll-batch",
    title: "one batched poll reads the schema and the blocks conditionally",
    async run(ctx) {
      const list = await ctx.client.blocksList();
      const calls = [
        {
          method: "blocks.list" as const,
          params: { ifNoneMatch: list.revision },
        },
      ];
      const outcomes = await ctx.client.batch(
        ctx.options.hasSchema === false
          ? calls
          : [
              {
                method: "schema.get" as const,
                params: { ifNoneMatch: (await ctx.client.schemaGet()).version },
              },
              ...calls,
            ],
      );
      for (const outcome of outcomes) {
        assert(outcome.ok, "every poll call succeeds");
        assert(
          (outcome.result as { notModified: boolean }).notModified,
          "nothing changed",
        );
      }
    },
  },
  {
    id: "refs/unsupported",
    title: "a ref on an endpoint without branches is Unsupported",
    async run(ctx) {
      const d = await ctx.describe();
      if (d.refs !== null) return ctx.skip("the endpoint has branches");
      await expectError(
        ctx.client.blocksList({ ref: "main" }),
        ErrorCode.Unsupported,
        "blocks.list ref",
      );
      await expectError(
        ctx.client.schemaGet({ ref: "main" }),
        ErrorCode.Unsupported,
        "schema.get ref",
      );
      if (!d.readOnly) {
        await expectError(
          ctx.client.blocksApply({ ref: "main", delete: [ctx.name()] }),
          ErrorCode.Unsupported,
          "blocks.apply ref",
        );
      }
    },
  },
  {
    id: "auth/token",
    title: "a missing or wrong bearer token is HTTP 401 with Unauthorized",
    async run(ctx) {
      if (ctx.options.token === undefined)
        return ctx.skip("the endpoint has no token");
      const body = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "describe",
      });
      for (const authorization of ["", "Bearer wrong-token"]) {
        const response = await ctx.raw(body, { headers: { authorization } });
        assertEqual(
          response.status,
          401,
          `HTTP status with "${authorization}"`,
        );
        assertEqual(
          (response.body as { error?: { code: number } }).error?.code,
          ErrorCode.Unauthorized,
          "the error code",
        );
      }
    },
  },
];
