import { describe, expect, test } from "bun:test";
import { fetchMainSchemaV8, mainSchemaAnswer } from "./use-main-schema-v8";

function answering(status: number, body: unknown) {
  return async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
}

describe("fetchMainSchemaV8 (isV8Schema on main's schema, read here)", () => {
  const schema = (value: unknown) =>
    answering(200, { jsonrpc: "2.0", id: 1, result: { schema: value } });

  test("decides v8 from the schema it fetched (no route of its own)", async () => {
    expect(
      await fetchMainSchemaV8("o", "p", schema({ blocksMajor: 8, root: {} })),
    ).toBe(true);
    // A v7 site: the route answers no v8 schema (`null`), or a schema
    // without the field.
    expect(await fetchMainSchemaV8("o", "p", schema(null))).toBe(false);
    expect(await fetchMainSchemaV8("o", "p", schema({ root: {} }))).toBe(false);
    expect(await fetchMainSchemaV8("o", "p", schema({ blocksMajor: 9 }))).toBe(
      false,
    );
  });

  test("Studio's gates settle it without a schema", async () => {
    const status = (code: number, body: unknown) =>
      fetchMainSchemaV8("o", "p", answering(code, body));
    // No repository: no main, as on main (v7).
    expect(await status(404, { code: "no_repository" })).toBe(false);
    expect(await status(403, { code: "feature_not_in_plan" })).toBe(false);
    // Gates that only a v8 main reaches.
    expect(await status(409, { code: "site_not_owned" })).toBe(true);
    expect(await status(503, { code: "hosted_delivery_unconfigured" })).toBe(
      true,
    );
  });

  test("an unreadable main is an error (retried), never a v7 answer", async () => {
    for (const [code, body] of [
      [502, { error: "GitHub is down" }],
      [500, null],
      [404, { error: "Virtual MCP not found" }],
      [409, { code: "main_schema_changed" }],
      [200, { jsonrpc: "2.0", id: 1, error: { code: -32001 } }],
      [200, { nope: 1 }],
    ] as const) {
      await expect(
        fetchMainSchemaV8("o", "p", answering(code, body)),
      ).rejects.toThrow();
    }
  });

  test("asks the project's content protocol for schema.get, uncached", async () => {
    let seen: { url: string; init?: RequestInit } | null = null;
    const doFetch = async (url: string, init?: RequestInit) => {
      seen = { url, init };
      return new Response('{"jsonrpc":"2.0","id":1,"result":{"schema":null}}');
    };
    await fetchMainSchemaV8("acme", "vm/1", doFetch);
    expect(seen!.url).toBe("/api/acme/decofile/vm%2F1/main/rpc");
    expect(seen!.init?.method).toBe("POST");
    expect(seen!.init?.cache).toBe("no-store");
    expect(JSON.parse(String(seen!.init?.body))).toMatchObject({
      method: "schema.get",
    });
    // Not an editor acting on a main answer: no main-schema header.
    expect(new Headers(seen!.init?.headers).has("x-deco-main-schema")).toBe(
      false,
    );
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
