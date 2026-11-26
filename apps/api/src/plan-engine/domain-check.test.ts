import { describe, expect, test } from "bun:test";
import { isPrivateUrl } from "@/mcp-clients/url-security";
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

const allowAll = async () => null;

function redirect(to: string): Response {
  return new Response(null, { status: 301, headers: { location: to } });
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
    expect(
      await checkDomain("loja.example", { fetcher, guard: allowAll }),
    ).toEqual({
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
    expect(
      await checkDomain("loja.example", { fetcher, guard: allowAll }),
    ).toEqual({
      ok: true,
      host: "loja.example",
      blocks_bots: true,
    });
  });

  test("dead domain", async () => {
    const fetcher = fake(async () => {
      throw new Error("dns");
    });
    const r = await checkDomain("morta.example", { fetcher, guard: allowAll });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.domain).toBe("morta.example");
      expect(r.reason).toContain("não respondeu");
    }
  });

  test("500", async () => {
    const fetcher = fake(async () => res(500, "https://loja.example/"));
    const r = await checkDomain("loja.example", { fetcher, guard: allowAll });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("HTTP 500");
  });

  test("does not try www.www", async () => {
    const calls: string[] = [];
    const fetcher = fake(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      throw new Error("dns");
    });
    await checkDomain("www.loja.example", { fetcher, guard: allowAll });
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
    expect(
      await checkDomain("loja.example", { fetcher, guard: allowAll }),
    ).toEqual({
      ok: true,
      host: "loja.example",
      blocks_bots: false,
    });
  });

  test("follows a redirect and answers with the host it landed on", async () => {
    const calls: string[] = [];
    const fetcher = fake(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      return url === "https://loja.example/"
        ? redirect("https://www.loja.example/")
        : res(200, url);
    });
    expect(
      await checkDomain("loja.example", { fetcher, guard: allowAll }),
    ).toEqual({
      ok: true,
      host: "www.loja.example",
      blocks_bots: false,
    });
    expect(calls).toEqual([
      "https://loja.example/",
      "https://www.loja.example/",
    ]);
  });

  test("never fetches a domain that points at a private network", async () => {
    const calls: string[] = [];
    const fetcher = fake(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return res(200, String(input));
    });
    const r = await checkDomain("interno.example", {
      fetcher,
      guard: async () => "URLs targeting private networks are not allowed",
    });
    expect(r).toEqual({
      ok: false,
      domain: "interno.example",
      reason: "endereço de rede interna",
    });
    expect(calls).toEqual([]);
  });

  test("refuses a redirect into a private network", async () => {
    const calls: string[] = [];
    const fetcher = fake(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return redirect("http://169.254.169.254/latest/meta-data/");
    });
    const literalsOnly = async (url: string) =>
      isPrivateUrl(url) ? "private" : null;
    const r = await checkDomain("www.loja.example", {
      fetcher,
      guard: literalsOnly,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("endereço de rede interna");
    expect(calls).toEqual(["https://www.loja.example/"]);
  });

  test("an IP literal of the API pod's network is refused", async () => {
    const fetcher = fake(async () => res(200, "https://10.0.0.5/"));
    const r = await checkDomain("10.0.0.5", { fetcher });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("endereço de rede interna");
  });

  test("stops after too many redirects", async () => {
    let n = 0;
    const fetcher = fake(async () =>
      redirect(`https://www.loja.example/${++n}`),
    );
    const r = await checkDomain("www.loja.example", {
      fetcher,
      guard: allowAll,
    });
    expect(r.ok).toBe(false);
    expect(n).toBe(6);
  });
});
