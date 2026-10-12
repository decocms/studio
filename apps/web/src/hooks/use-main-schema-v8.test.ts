import { describe, expect, test } from "bun:test";
import { fetchMainSchemaV8, mainSchemaAnswer } from "./use-main-schema-v8";

function answering(status: number, body: unknown) {
  return async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
}

describe("fetchMainSchemaV8 (the server's isV8Schema on main)", () => {
  test("reads the server's answer", async () => {
    expect(
      await fetchMainSchemaV8("o", "p", answering(200, { isV8: true })),
    ).toBe(true);
    expect(
      await fetchMainSchemaV8("o", "p", answering(200, { isV8: false })),
    ).toBe(false);
  });

  test("no repository (isV8: null) has no main: not a v8 site", async () => {
    expect(
      await fetchMainSchemaV8("o", "p", answering(200, { isV8: null })),
    ).toBe(false);
  });

  test("an unreadable main is an error (retried), never a v7 answer", async () => {
    await expect(
      fetchMainSchemaV8("o", "p", answering(502, { code: "main_unreadable" })),
    ).rejects.toThrow();
    await expect(
      fetchMainSchemaV8("o", "p", answering(200, { nope: 1 })),
    ).rejects.toThrow();
  });

  test("asks the project's own endpoint, uncached", async () => {
    let seen: { url: string; init?: RequestInit } | null = null;
    const doFetch = async (url: string, init?: RequestInit) => {
      seen = { url, init };
      return new Response('{"isV8":false}', { status: 200 });
    };
    await fetchMainSchemaV8("acme", "vm/1", doFetch);
    expect(seen!.url).toBe("/api/acme/blocks-major/vm%2F1");
    expect(seen!.init?.method).toBe("POST");
    expect(seen!.init?.cache).toBe("no-store");
  });
});

describe("mainSchemaAnswer", () => {
  const base = { asks: true, hasProject: true, isError: false, marked: false };

  test("loading until the server answers; the editor waits", () => {
    expect(mainSchemaAnswer({ ...base, data: undefined })).toBe("loading");
  });

  test("the answer, once known (kept through a failed refetch)", () => {
    expect(mainSchemaAnswer({ ...base, data: true })).toBe("v8");
    expect(mainSchemaAnswer({ ...base, data: false })).toBe("v7");
    expect(mainSchemaAnswer({ ...base, data: true, isError: true })).toBe("v8");
  });

  test("a failed first read on a site last found v8 is an error (the v8 editor waits)", () => {
    expect(
      mainSchemaAnswer({
        ...base,
        data: undefined,
        isError: true,
        marked: true,
      }),
    ).toBe("error");
  });

  test("a failed first read on any other site is v7, as on main (no wait)", () => {
    expect(mainSchemaAnswer({ ...base, data: undefined, isError: true })).toBe(
      "v7",
    );
  });

  test("a later answer wins over the fallback", () => {
    expect(
      mainSchemaAnswer({ ...base, data: true, isError: false, marked: false }),
    ).toBe("v8");
  });

  test("no project, or one without a repository, has no main: v7, no wait", () => {
    expect(
      mainSchemaAnswer({ ...base, hasProject: false, data: undefined }),
    ).toBe("v7");
    expect(mainSchemaAnswer({ ...base, asks: false, data: undefined })).toBe(
      "v7",
    );
  });
});
