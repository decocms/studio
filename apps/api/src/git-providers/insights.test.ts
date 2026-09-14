import { describe, expect, test } from "bun:test";
import {
  cappedLimit,
  loginLooksLikeBot,
  pageFromCursor,
  readCappedBody,
} from "./insights";

describe("cappedLimit", () => {
  test("an absent ask takes the default, itself bounded by the ceiling", () => {
    expect(cappedLimit(undefined, 400, 2000)).toBe(400);
    expect(cappedLimit(undefined, 5000, 2000)).toBe(2000);
  });

  test("an ask past the ceiling is clamped, not refused", () => {
    expect(cappedLimit(9999, 400, 2000)).toBe(2000);
  });

  test("a zero or negative ask reads as 'no preference', never as an empty page", () => {
    expect(cappedLimit(0, 400, 2000)).toBe(400);
    expect(cappedLimit(-10, 400, 2000)).toBe(400);
    expect(cappedLimit(Number.NaN, 400, 2000)).toBe(400);
  });

  test("a fractional ask floors rather than reaching the provider as a fraction", () => {
    expect(cappedLimit(10.9, 400, 2000)).toBe(10);
  });
});

describe("loginLooksLikeBot", () => {
  test("GitHub App actors end in [bot]", () => {
    expect(loginLooksLikeBot("dependabot[bot]")).toBe(true);
    expect(loginLooksLikeBot("github-actions[bot]")).toBe(true);
  });

  test("the service-account conventions every CI vendor uses", () => {
    expect(loginLooksLikeBot("renovate")).toBe(true);
    expect(loginLooksLikeBot("dependabot")).toBe(true);
    expect(loginLooksLikeBot("release-bot")).toBe(true);
    expect(loginLooksLikeBot("bot.deployer")).toBe(true);
  });

  test("a person whose name merely contains those letters is not a machine", () => {
    expect(loginLooksLikeBot("robotnik")).toBe(false);
    expect(loginLooksLikeBot("bottomley")).toBe(false);
    expect(loginLooksLikeBot("abbot")).toBe(false);
  });

  test("an absent author is not a bot", () => {
    expect(loginLooksLikeBot("")).toBe(false);
    expect(loginLooksLikeBot("   ")).toBe(false);
  });
});

describe("pageFromCursor", () => {
  test("a cursor we minted pages forward", () => {
    expect(pageFromCursor("3")).toBe(3);
  });

  test("absent, garbled or out-of-range restarts the listing instead of failing", () => {
    expect(pageFromCursor(null)).toBe(1);
    expect(pageFromCursor(undefined)).toBe(1);
    expect(pageFromCursor("")).toBe(1);
    expect(pageFromCursor("not-a-page")).toBe(1);
    expect(pageFromCursor("0")).toBe(1);
    expect(pageFromCursor("-4")).toBe(1);
    expect(pageFromCursor("2.5")).toBe(1);
  });
});

describe("readCappedBody", () => {
  test("a body under the budget comes back whole and untruncated", async () => {
    const result = await readCappedBody(new Response("hello"), 100);
    expect(result).toEqual({ content: "hello", size: 5, truncated: false });
  });

  test("a body over the budget stops at it and says so", async () => {
    const result = await readCappedBody(new Response("0123456789"), 4);
    expect(result.content).toBe("0123");
    expect(result.truncated).toBe(true);
  });

  test("size reports the file's true length even when the read stopped short", async () => {
    const body = "x".repeat(1000);
    const res = new Response(body, {
      headers: { "content-length": String(body.length) },
    });
    const result = await readCappedBody(res, 10);
    expect(result.content).toHaveLength(10);
    expect(result.size).toBe(1000);
    expect(result.truncated).toBe(true);
  });

  test("a body exactly at the budget is not reported as truncated", async () => {
    const result = await readCappedBody(new Response("abcd"), 4);
    expect(result).toEqual({ content: "abcd", size: 4, truncated: false });
  });

  test("an empty body is content, not absence", async () => {
    const result = await readCappedBody(new Response(""), 100);
    expect(result.content).toBe("");
    expect(result.truncated).toBe(false);
  });

  test("a chunked body is assembled across reads", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("part-one-"));
        controller.enqueue(new TextEncoder().encode("part-two"));
        controller.close();
      },
    });
    const result = await readCappedBody(new Response(stream), 100);
    expect(result.content).toBe("part-one-part-two");
    expect(result.truncated).toBe(false);
  });
});
