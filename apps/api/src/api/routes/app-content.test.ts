/**
 * HTTP layer of the published app-content route: cache window, stale-if-error,
 * ETag/304, gzip and the per-IP limiter. The loader (gates + GitHub) is the
 * injected boundary; its gate order is exercised against real Postgres and
 * GitHub only end to end.
 */

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { StudioContext } from "@/core/studio-context";
import {
  createAppContentRoutes,
  etagMatches,
  type PublishedLoad,
  type PublishedLoader,
} from "./app-content";

const BODY = '{"pages-home":{"sections":[]}}';

function buildApp(load: PublishedLoader, clock = { now: 0 }) {
  const app = new Hono<{ Variables: { studioContext: StudioContext } }>();
  app.use("*", async (c, next) => {
    c.set("studioContext", {
      organization: { id: "org_1", slug: "acme", name: "Acme" },
    } as unknown as StudioContext);
    await next();
  });
  app.route(
    "/app-content",
    createAppContentRoutes({ load, now: () => clock.now }),
  );
  return app;
}

function countingLoader(result: () => PublishedLoad | Promise<PublishedLoad>) {
  const calls: Array<PublishedLoad | undefined> = [];
  const load: PublishedLoader = async (_ctx, _org, _id, previous) => {
    calls.push(previous);
    return result();
  };
  return { load, calls };
}

const published: PublishedLoad = { sha: "abc123", body: BODY, cache: true };

describe("GET /app-content/:virtualMcpId", () => {
  test("serves the published decofile with cache headers", async () => {
    const { load } = countingLoader(() => published);
    const res = await buildApp(load).request("/app-content/vir_1");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(BODY);
    expect(res.headers.get("etag")).toBe('"abc123"');
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=60, stale-while-revalidate=300, stale-if-error=86400",
    );
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-type")).toStartWith("application/json");
  });

  test("answers 304 when If-None-Match carries the ETag", async () => {
    const { load } = countingLoader(() => published);
    const app = buildApp(load);
    for (const inm of ['"abc123"', 'W/"abc123"', '"old", "abc123"']) {
      const res = await app.request("/app-content/vir_1", {
        headers: { "if-none-match": inm },
      });
      expect(res.status).toBe(304);
      expect(res.headers.get("etag")).toBe('"abc123"');
    }
    const stale = await app.request("/app-content/vir_1", {
      headers: { "if-none-match": '"old"' },
    });
    expect(stale.status).toBe(200);
  });

  test("gzips when asked", async () => {
    const { load } = countingLoader(() => published);
    const res = await buildApp(load).request("/app-content/vir_1", {
      headers: { "accept-encoding": "br, gzip" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBe("gzip");
    expect(res.headers.get("vary")).toBe("Accept-Encoding");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(new TextDecoder().decode(Bun.gunzipSync(bytes))).toBe(BODY);
  });

  test("every gate failure is the same 404", async () => {
    for (const result of [
      { sha: null, body: null, cache: false },
      { sha: null, body: null, cache: true },
      { sha: "abc123", body: null, cache: true },
    ]) {
      const { load } = countingLoader(() => result);
      const res = await buildApp(load).request("/app-content/vir_1");
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Not found" });
    }
  });

  test("rejects malformed ids without loading", async () => {
    const { load, calls } = countingLoader(() => published);
    const res = await buildApp(load).request("/app-content/vir.1");
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  test("revalidates at most every 30s and hands the loader the previous entry", async () => {
    const clock = { now: 0 };
    const { load, calls } = countingLoader(() => published);
    const app = buildApp(load, clock);
    await app.request("/app-content/vir_1");
    clock.now = 29_999;
    await app.request("/app-content/vir_1");
    expect(calls).toHaveLength(1);
    clock.now = 30_000;
    await app.request("/app-content/vir_1");
    expect(calls).toHaveLength(2);
    expect(calls[1]?.sha).toBe("abc123");
  });

  test("never caches ids that are not a project", async () => {
    const { load, calls } = countingLoader(() => ({
      sha: null,
      body: null,
      cache: false,
    }));
    const app = buildApp(load);
    await app.request("/app-content/vir_1");
    await app.request("/app-content/vir_1");
    expect(calls).toHaveLength(2);
  });

  test("serves the stale body when upstream fails, 502 with nothing cached", async () => {
    const clock = { now: 0 };
    let fail = false;
    const { load } = countingLoader(() => {
      if (fail) throw new Error("GitHub down");
      return published;
    });
    const app = buildApp(load, clock);
    expect((await app.request("/app-content/vir_1")).status).toBe(200);
    fail = true;
    clock.now = 60_000;
    const stale = await app.request("/app-content/vir_1");
    expect(stale.status).toBe(200);
    expect(await stale.text()).toBe(BODY);

    const cold = await app.request("/app-content/vir_2");
    expect(cold.status).toBe(502);
  });

  test("limits each IP to 120 requests a minute", async () => {
    const { load } = countingLoader(() => published);
    const app = buildApp(load);
    const headers = { "cf-connecting-ip": "203.0.113.7" };
    for (let i = 0; i < 120; i++) {
      expect(
        (await app.request("/app-content/vir_1", { headers })).status,
      ).toBe(200);
    }
    expect((await app.request("/app-content/vir_1", { headers })).status).toBe(
      429,
    );
    const other = await app.request("/app-content/vir_1", {
      headers: { "cf-connecting-ip": "203.0.113.8" },
    });
    expect(other.status).toBe(200);
  });
});

describe("etagMatches", () => {
  test("matches exact, weak, listed and wildcard tags", () => {
    expect(etagMatches('"a"', '"a"')).toBe(true);
    expect(etagMatches('W/"a"', '"a"')).toBe(true);
    expect(etagMatches('"b", "a"', '"a"')).toBe(true);
    expect(etagMatches("*", '"a"')).toBe(true);
    expect(etagMatches('"b"', '"a"')).toBe(false);
    expect(etagMatches(undefined, '"a"')).toBe(false);
  });
});
