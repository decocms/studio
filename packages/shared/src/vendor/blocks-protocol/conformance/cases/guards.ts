/**
 * Limits, the secret guard and request-key idempotency.
 */
import { encryptToCiphertext, publicKeyPemFromDer } from "../../ciphertext";
import { ErrorCode, type InvalidBlockData } from "../../errors";
import {
  assert,
  assertEqual,
  type ConformanceContext,
  expectError,
  rawErrorCode,
} from "../context";
import type { ConformanceCase } from "./types";

async function writable(ctx: ConformanceContext) {
  const d = await ctx.describe();
  if (d.readOnly) return ctx.skip("read-only endpoint");
  return d;
}

async function withIdempotency(ctx: ConformanceContext) {
  const d = await writable(ctx);
  if (!d.writes.idempotency) return ctx.skip("request keys aren't advertised");
  return d;
}

/** A throwaway public key, for endpoints that don't report one. */
async function ephemeralPublicKey(): Promise<string> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["encrypt", "decrypt"],
  )) as CryptoKeyPair;
  return publicKeyPemFromDer(
    new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey)),
  );
}

/** A real ciphertext: encrypted with the endpoint's public key when it reports one. */
async function realCiphertext(
  ctx: ConformanceContext,
  value: string,
): Promise<string> {
  const publicKey =
    (await ctx.describe()).secrets?.publicKey ?? (await ephemeralPublicKey());
  return encryptToCiphertext(publicKey, value);
}

const key = (ctx: ConformanceContext, label: string) =>
  `${ctx.prefix}-${label}-${Math.random().toString(36).slice(2)}`;

export const guardCases: ConformanceCase[] = [
  {
    id: "limits/ops-per-apply",
    title: "more names than maxOpsPerApply is LimitExceeded",
    async run(ctx) {
      const d = await writable(ctx);
      const names = Array.from(
        { length: d.limits.maxOpsPerApply + 1 },
        (_, i) => `${ctx.prefix}-op-${i}`,
      );
      await expectError(
        ctx.client.blocksApply({ delete: names }),
        ErrorCode.LimitExceeded,
        "too many names",
      );
    },
  },
  {
    id: "limits/block-bytes",
    title: "an entry over maxBlockBytes is refused and nothing is written",
    async run(ctx) {
      const d = await writable(ctx);
      if (d.limits.maxBlockBytes + 1024 > d.limits.maxRequestBytes)
        return ctx.skip("the request limit is lower");
      const big = ctx.name("big");
      const small = ctx.name("small");
      const error = await expectError(
        ctx.client.blocksApply({
          set: {
            [big]: { text: "x".repeat(d.limits.maxBlockBytes) },
            [small]: { ok: true },
          },
        }),
        ErrorCode.InvalidBlock,
        "an oversized entry",
      );
      const violations = (error.data as InvalidBlockData).violations;
      assert(
        violations.some((v) => v.name === big),
        "the violation names the entry",
      );
      const list = await ctx.client.blocksList();
      assert(
        !list.notModified && !(small in list.blocks),
        "nothing was written",
      );
    },
  },
  {
    id: "limits/request-bytes",
    title: "a body over maxRequestBytes is HTTP 413 with LimitExceeded",
    async run(ctx) {
      const d = await ctx.describe();
      if (d.limits.maxRequestBytes > 64 * 1024 * 1024)
        return ctx.skip("the request limit is too large to probe");
      const body = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "blocks.apply",
        params: {
          set: {
            [ctx.name("huge")]: { text: "x".repeat(d.limits.maxRequestBytes) },
          },
        },
      });
      const response = await ctx.raw(body);
      assertEqual(response.status, 413, "HTTP status");
      assertEqual(
        rawErrorCode(response.body),
        ErrorCode.LimitExceeded,
        "the error code",
      );
    },
  },
  {
    id: "limits/list-bytes",
    title:
      "a block list over maxListBytes is LimitExceeded, never a partial map",
    async run(ctx) {
      const d = await writable(ctx);
      const { maxListBytes, maxBlockBytes, maxOpsPerApply } = d.limits;
      if (maxListBytes > 512 * 1024)
        return ctx.skip("maxListBytes is too large to probe");
      const size = Math.min(maxBlockBytes, 64 * 1024) - 64;
      const count = Math.ceil(maxListBytes / size) + 1;
      if (count > maxOpsPerApply * 4)
        return ctx.skip("would need too many writes");
      for (let i = 0; i < count; i++) {
        await ctx.client.blocksApply({
          set: { [ctx.name("fill")]: { text: "x".repeat(size) } },
        });
      }
      await expectError(
        ctx.client.blocksList(),
        ErrorCode.LimitExceeded,
        "an oversized list",
      );
    },
  },
  {
    id: "limits/batch-response-bytes",
    title:
      "a batch response over maxBatchResponseBytes answers later reads with LimitExceeded, never a write",
    async run(ctx) {
      const d = await writable(ctx);
      const { maxBatchResponseBytes, maxBlockBytes, maxListBytes } = d.limits;
      if (maxBatchResponseBytes > 1024 * 1024)
        return ctx.skip("maxBatchResponseBytes is too large to probe");
      // Enough content that one list fits the budget but four don't.
      const target = Math.floor(maxBatchResponseBytes / 3);
      if (target > maxListBytes / 2)
        return ctx.skip("maxListBytes is lower than the probe needs");
      const size = Math.min(maxBlockBytes, 64 * 1024) - 64;
      for (let filled = 0; filled < target; filled += size) {
        await ctx.client.blocksApply({
          set: { [ctx.name("fill")]: { text: "x".repeat(size) } },
        });
      }
      const write = ctx.name("batch-write");
      const req = (id: number, method: string, params: unknown) => ({
        jsonrpc: "2.0",
        id,
        method,
        params,
      });
      const response = await ctx.rpc([
        req(1, "blocks.list", {}),
        req(2, "blocks.list", {}),
        req(3, "blocks.list", {}),
        req(4, "blocks.list", {}),
        req(5, "blocks.apply", { set: { [write]: { kept: true } } }),
        req(6, "blocks.list", {}),
      ]);
      const items = response.body as Array<{
        id: number;
        result?: unknown;
        error?: { code: number; data?: { limit?: string } };
      }>;
      assert(
        Array.isArray(items) && items.length === 6,
        "one response per call",
      );
      assert(!items[0].error, "the first read fits");
      const over = items.filter(
        (i) => i.error?.code === ErrorCode.LimitExceeded,
      );
      assert(over.length > 0, "a read over the budget is LimitExceeded");
      assert(
        over.every((i) => i.error?.data?.limit === "maxBatchResponseBytes"),
        "the error names maxBatchResponseBytes",
      );
      assert(
        items[4].result !== undefined,
        "the write still answers with its result",
      );
      const list = await ctx.client.blocksList();
      assert(!list.notModified && write in list.blocks, "the write landed");
    },
  },
  {
    id: "limits/schema-bytes",
    title:
      "a schema over maxSchemaBytes is LimitExceeded for schema.get and for writes",
    async run(ctx) {
      if (!ctx.options.schemaOverLimit)
        return ctx.skip("the harness serves a schema within limits");
      await expectError(
        ctx.client.schemaGet(),
        ErrorCode.LimitExceeded,
        "schema.get",
      );
      const d = await ctx.describe();
      if (d.readOnly) return;
      const name = ctx.name("schema-limited");
      await expectError(
        ctx.client.blocksApply({ set: { [name]: { v: 1 } } }),
        ErrorCode.LimitExceeded,
        "a write checked against the schema",
      );
      const list = await ctx.client.blocksList();
      assert(
        !list.notModified && !(name in list.blocks),
        "nothing was written",
      );
    },
  },
  {
    id: "secrets/guard",
    title:
      "a Secret field accepts only a secret block with a well-formed ciphertext",
    async run(ctx) {
      await writable(ctx);
      const fixture = ctx.options.secretField;
      if (!fixture) return ctx.skip("no secretField fixture");
      const block = (value: unknown) => ({
        __resolveType: fixture.blockType,
        [fixture.field]: value,
      });
      const plain = ctx.name("plain-secret");
      const error = await expectError(
        ctx.client.blocksApply({ set: { [plain]: block("hunter2") } }),
        ErrorCode.InvalidBlock,
        "plain text in a Secret field",
      );
      const violation = (error.data as InvalidBlockData).violations[0];
      assertEqual(violation?.name, plain, "the violation names the entry");
      // Text that only looks like a ciphertext is plain text all the same.
      for (const ciphertext of [
        "hunter2",
        "v1.hunter2",
        "v1.my-api-key_123",
        "v1.QUJD.ZGVm",
      ]) {
        await expectError(
          ctx.client.blocksApply({
            set: {
              [ctx.name("bad-cipher")]: block({
                __resolveType: "secret",
                ciphertext,
              }),
            },
          }),
          ErrorCode.InvalidBlock,
          `the malformed ciphertext ${JSON.stringify(ciphertext)}`,
        );
      }
      const ok = ctx.name("secret");
      const ciphertext = await realCiphertext(ctx, "conformance-value");
      await ctx.client.blocksApply({
        set: { [ok]: block({ __resolveType: "secret", ciphertext }) },
      });
      const list = await ctx.client.blocksList();
      assert(
        !list.notModified && ok in list.blocks,
        "an encrypted value is saved",
      );
    },
  },
  {
    id: "idempotency/unadvertised",
    title:
      "a request key is refused when the endpoint doesn't advertise receipts",
    async run(ctx) {
      const d = await writable(ctx);
      if (d.writes.idempotency) return ctx.skip("request keys are advertised");
      await expectError(
        ctx.client.blocksApply({
          requestKey: key(ctx, "k"),
          delete: [ctx.name()],
        }),
        ErrorCode.Unsupported,
        "a request key",
      );
    },
  },
  {
    id: "idempotency/retry",
    title:
      "retrying with the same key returns the original result, even after the content moved",
    async run(ctx) {
      await withIdempotency(ctx);
      const name = ctx.name("retry");
      const params = {
        requestKey: key(ctx, "retry"),
        set: { [name]: { v: 1 } },
      };
      const first = await ctx.client.blocksApply(params);
      await ctx.client.blocksApply({
        set: { [ctx.name("advance")]: { v: 1 } },
      });
      const second = await ctx.client.blocksApply(params);
      assertEqual(second, first, "the replayed result");
      const list = await ctx.client.blocksList();
      assert(
        !list.notModified && list.versions[name] === first.versions[name],
        "written once",
      );
    },
  },
  {
    id: "idempotency/different-params",
    title: "reusing a key for a different request is Invalid params",
    async run(ctx) {
      await withIdempotency(ctx);
      const requestKey = key(ctx, "reuse");
      const name = ctx.name("reuse");
      await ctx.client.blocksApply({ requestKey, set: { [name]: { v: 1 } } });
      await expectError(
        ctx.client.blocksApply({ requestKey, set: { [name]: { v: 2 } } }),
        ErrorCode.InvalidParams,
        "a different body",
      );
    },
  },
  {
    id: "idempotency/simultaneous",
    title: "simultaneous duplicates commit once and share one result",
    async run(ctx) {
      await withIdempotency(ctx);
      const params = {
        requestKey: key(ctx, "dup"),
        set: { [ctx.name("dup")]: { v: 1 } },
      };
      const results = await Promise.all(
        [1, 2, 3].map(() => ctx.client.blocksApply(params)),
      );
      assertEqual(results[1], results[0], "the second result");
      assertEqual(results[2], results[0], "the third result");
    },
  },
  {
    id: "idempotency/restart",
    title: "receipts survive a server restart",
    async run(ctx) {
      await withIdempotency(ctx);
      if (!ctx.options.restart) return ctx.skip("no restart hook");
      const params = {
        requestKey: key(ctx, "restart"),
        set: { [ctx.name("restart")]: { v: 1 } },
      };
      const first = await ctx.client.blocksApply(params);
      await ctx.options.restart();
      assertEqual(
        await ctx.client.blocksApply(params),
        first,
        "the replayed result",
      );
    },
  },
  {
    id: "idempotency/tenant-isolation",
    title: "one tenant's receipts never answer another tenant's requests",
    async run(ctx) {
      await withIdempotency(ctx);
      if (!ctx.options.otherTenant)
        return ctx.skip("no otherTenant credentials");
      const requestKey = key(ctx, "tenant");
      const a = ctx.name("tenant-a");
      const b = ctx.name("tenant-b");
      await ctx.client.blocksApply({ requestKey, set: { [a]: { v: 1 } } });
      const other = ctx.clientFor(ctx.options.otherTenant);
      const result = await other.blocksApply({
        requestKey,
        set: { [b]: { v: 1 } },
      });
      assert(
        typeof result.versions[b] === "string",
        "the other tenant's write ran",
      );
    },
  },
];
