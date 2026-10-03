/**
 * The wire format: JSON-RPC 2.0 envelopes, batches, HTTP status codes, gzip.
 */
import { ErrorCode } from "../../errors";
import { MAX_BATCH_CALLS } from "../../types";
import { assert, assertEqual, rawErrorCode } from "../context";
import type { ConformanceCase } from "./types";

const req = (id: unknown, method: string, params?: unknown) =>
  params === undefined
    ? { jsonrpc: "2.0", id, method }
    : { jsonrpc: "2.0", id, method, params };

export const wireCases: ConformanceCase[] = [
  {
    id: "wire/ids-echoed",
    title: "string and number ids are echoed back",
    async run(ctx) {
      const a = await ctx.rpc(req("abc", "describe", {}));
      assert(a.status === 200, `HTTP ${a.status}`);
      assertEqual((a.body as { id: unknown }).id, "abc", "the string id");
      const b = await ctx.rpc(req(42, "describe"));
      assertEqual((b.body as { id: unknown }).id, 42, "the number id");
      assert(
        "result" in (b.body as object),
        "describe without params succeeds",
      );
    },
  },
  {
    id: "wire/id-required",
    title: "a request without an id is rejected, not run",
    async run(ctx) {
      const response = await ctx.rpc({ jsonrpc: "2.0", method: "describe" });
      assert(response.status === 200, `HTTP ${response.status}`);
      assertEqual(
        rawErrorCode(response.body),
        ErrorCode.InvalidRequest,
        "the error code",
      );
      assertEqual((response.body as { id: unknown }).id, null, "the error id");
    },
  },
  {
    id: "wire/envelope",
    title:
      "a bad envelope is Invalid Request; an unknown method is Method not found",
    async run(ctx) {
      const wrongVersion = await ctx.rpc({
        jsonrpc: "1.0",
        id: 1,
        method: "describe",
      });
      assertEqual(
        rawErrorCode(wrongVersion.body),
        ErrorCode.InvalidRequest,
        "jsonrpc 1.0",
      );
      const unknown = await ctx.rpc(req(1, "blocks.rename", {}));
      assertEqual(
        rawErrorCode(unknown.body),
        ErrorCode.MethodNotFound,
        "an unknown method",
      );
      const arrayParams = await ctx.rpc(req(1, "describe", []));
      assertEqual(
        rawErrorCode(arrayParams.body),
        ErrorCode.InvalidParams,
        "array params",
      );
      const unknownParam = await ctx.rpc(req(1, "blocks.list", { since: "x" }));
      assertEqual(
        rawErrorCode(unknownParam.body),
        ErrorCode.InvalidParams,
        "an unknown parameter",
      );
    },
  },
  {
    id: "wire/parse-error",
    title: "malformed JSON is a Parse error",
    async run(ctx) {
      const response = await ctx.raw("{not json");
      assert(response.status === 200, `HTTP ${response.status}`);
      assertEqual(
        rawErrorCode(response.body),
        ErrorCode.ParseError,
        "the error code",
      );
    },
  },
  {
    id: "wire/content-type",
    title: "only JSON bodies and POST are accepted",
    async run(ctx) {
      const form = await ctx.raw("a=1", {
        headers: { "content-type": "application/x-www-form-urlencoded" },
      });
      assert(form.status >= 400, `a form post answered HTTP ${form.status}`);
      const get = await ctx.raw("", { method: "GET" });
      assert(get.status >= 400, `a GET answered HTTP ${get.status}`);
    },
  },
  {
    id: "wire/batch-order",
    title: "a batch runs in order and returns results in order",
    async run(ctx) {
      const response = await ctx.rpc([
        req(1, "describe"),
        req(2, "nope"),
        req("three", "blocks.list", {}),
      ]);
      assert(Array.isArray(response.body), "a batch answers with an array");
      const items = response.body as Array<{
        id: unknown;
        error?: { code: number };
      }>;
      assertEqual(
        items.map((i) => i.id),
        [1, 2, "three"],
        "the response ids",
      );
      assert(!items[0].error, "the first call succeeds");
      assertEqual(
        items[1].error?.code,
        ErrorCode.MethodNotFound,
        "the second call fails alone",
      );
      assert(!items[2].error, "the third call still runs");
    },
  },
  {
    id: "wire/batch-limits",
    title: `an empty batch is invalid; more than ${MAX_BATCH_CALLS} calls is LimitExceeded`,
    async run(ctx) {
      const empty = await ctx.rpc([]);
      assertEqual(
        rawErrorCode(empty.body),
        ErrorCode.InvalidRequest,
        "an empty batch",
      );
      const calls = Array.from({ length: MAX_BATCH_CALLS + 1 }, (_, i) =>
        req(i + 1, "describe"),
      );
      const tooMany = await ctx.rpc(calls);
      assertEqual(
        rawErrorCode(tooMany.body),
        ErrorCode.LimitExceeded,
        "an oversized batch",
      );
      const ok = await ctx.rpc(calls.slice(0, MAX_BATCH_CALLS));
      assert(
        Array.isArray(ok.body) && ok.body.length === MAX_BATCH_CALLS,
        `a batch of ${MAX_BATCH_CALLS} runs`,
      );
    },
  },
  {
    id: "wire/batch-not-atomic",
    title: "a batch isn't atomic: a failed write doesn't undo an earlier one",
    async run(ctx) {
      const description = await ctx.describe();
      if (description.readOnly) return ctx.skip("read-only endpoint");
      const good = ctx.name("batch");
      const response = await ctx.rpc([
        req(1, "blocks.apply", { set: { [good]: { title: "kept" } } }),
        req(2, "blocks.apply", { set: { [ctx.name("bad")]: [] } }),
      ]);
      const items = response.body as Array<{ error?: { code: number } }>;
      assert(!items[0].error, "the first write succeeds");
      assertEqual(
        items[1].error?.code,
        ErrorCode.InvalidBlock,
        "the second write fails",
      );
      const list = await ctx.client.blocksList();
      assert(
        !list.notModified && good in list.blocks,
        "the first write landed",
      );
    },
  },
  {
    id: "wire/gzip",
    title: "responses are gzip-compressed when the request accepts it",
    async run(ctx) {
      const description = await ctx.describe();
      if (description.readOnly) return ctx.skip("read-only endpoint");
      const name = ctx.name("gzip");
      await ctx.client.blocksApply({
        set: { [name]: { text: "x".repeat(8 * 1024) } },
      });
      const response = await ctx.rpc(req(1, "blocks.list", {}), {
        "accept-encoding": "gzip",
      });
      assertEqual(
        response.headers.get("content-encoding"),
        "gzip",
        "Content-Encoding",
      );
      assert(
        rawErrorCode(response.body) === undefined,
        "the gzip body decodes to a result",
      );
    },
  },
];
