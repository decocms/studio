import { describe, expect, test } from "bun:test";
import { checkDomain } from "./domain-check.ts";

function res(status: number, url: string): Response {
  const r = new Response(null, { status: status === 200 ? 200 : status });
  Object.defineProperty(r, "url", { value: url });
  return r;
}

function fake(
  fn: (input: RequestInfo | URL) => Promise<Response>,
): typeof fetch {
  return Object.assign(fn, { preconnect: () => {} });
}

describe("checkDomain", () => {
  test("answers only on www", async () => {
    const calls: string[] = [];
    const fetcher = fake(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url === "https://loja.example/") throw new Error("dns");
      return res(200, "https://www.loja.example/");
    });
    expect(await checkDomain("loja.example", fetcher)).toEqual({
      ok: true,
      host: "www.loja.example",
      blocks_bots: false,
    });
    expect(calls).toEqual([
      "https://loja.example/",
      "https://www.loja.example/",
    ]);
  });

  test("403 counts as existing", async () => {
    const fetcher = fake(async () => res(403, "https://loja.example/"));
    expect(await checkDomain("loja.example", fetcher)).toEqual({
      ok: true,
      host: "loja.example",
      blocks_bots: true,
    });
  });

  test("dead domain", async () => {
    const fetcher = fake(async () => {
      throw new Error("dns");
    });
    const r = await checkDomain("morta.example", fetcher);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.domain).toBe("morta.example");
      expect(r.reason).toContain("não respondeu");
    }
  });

  test("500", async () => {
    const fetcher = fake(async () => res(500, "https://loja.example/"));
    const r = await checkDomain("loja.example", fetcher);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("HTTP 500");
  });

  test("does not try www.www", async () => {
    const calls: string[] = [];
    const fetcher = fake(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      throw new Error("dns");
    });
    await checkDomain("www.loja.example", fetcher);
    expect(calls).toEqual(["https://www.loja.example/"]);
  });

  test("a body that fails to cancel does not undo the answer", async () => {
    const fetcher = fake(async () => {
      const r = res(200, "https://loja.example/");
      Object.defineProperty(r, "body", {
        value: { cancel: () => Promise.reject(new Error("locked")) },
      });
      return r;
    });
    expect(await checkDomain("loja.example", fetcher)).toEqual({
      ok: true,
      host: "loja.example",
      blocks_bots: false,
    });
  });
});
