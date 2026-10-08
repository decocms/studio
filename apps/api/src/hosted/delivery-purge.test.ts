import { describe, expect, it } from "bun:test";
import { createDeliveryPurge } from "./delivery-purge";
import { CACHE_LATEST, CACHE_REVISION, CACHE_DRAFT } from "./delivery-store";

const KEY = "sites/acme/latest.json";

function fakeFetch(responses: Array<{ status: number; success: boolean }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = responses[Math.min(calls.length - 1, responses.length - 1)]!;
    return new Response(JSON.stringify({ success: r.success }), {
      status: r.status,
    });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("cache headers", () => {
  it("lets the edge hold latest.json 1 h while every reader revalidates", () => {
    expect(CACHE_LATEST).toBe(
      "public, max-age=0, s-maxage=3600, must-revalidate",
    );
    expect(CACHE_REVISION).toBe("public, max-age=31536000, immutable");
    expect(CACHE_DRAFT).toBe("no-cache, max-age=0, must-revalidate");
  });
});

describe("createDeliveryPurge", () => {
  it("purges exactly the object's public URL on the zone", async () => {
    const f = fakeFetch([{ status: 200, success: true }]);
    await createDeliveryPurge({
      zoneId: "zone1",
      apiToken: "tok",
      fetch: f.fn,
    }).purge(KEY);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe(
      "https://api.cloudflare.com/client/v4/zones/zone1/purge_cache",
    );
    expect(f.calls[0]!.init.method).toBe("POST");
    expect(
      (f.calls[0]!.init.headers as Record<string, string>).authorization,
    ).toBe("Bearer tok");
    expect(JSON.parse(f.calls[0]!.init.body as string)).toEqual({
      files: ["https://delivery.decocms.com/sites/acme/latest.json"],
    });
  });

  it("uses the configured public delivery origin", async () => {
    const f = fakeFetch([{ status: 200, success: true }]);
    await createDeliveryPurge({
      zoneId: "zone1",
      apiToken: "tok",
      publicOrigin: "http://localhost:9999/",
      fetch: f.fn,
    }).purge(KEY);
    expect(JSON.parse(f.calls[0]!.init.body as string)).toEqual({
      files: ["http://localhost:9999/sites/acme/latest.json"],
    });
  });

  it("retries a failed attempt once and succeeds when the retry does", async () => {
    const f = fakeFetch([
      { status: 503, success: false },
      { status: 200, success: true },
    ]);
    await createDeliveryPurge({
      zoneId: "z",
      apiToken: "t",
      fetch: f.fn,
    }).purge(KEY);
    expect(f.calls).toHaveLength(2);
  });

  it("fails when both attempts fail: exactly two calls", async () => {
    const f = fakeFetch([
      { status: 503, success: false },
      { status: 502, success: false },
      { status: 200, success: true },
    ]);
    await expect(
      createDeliveryPurge({ zoneId: "z", apiToken: "t", fetch: f.fn }).purge(
        KEY,
      ),
    ).rejects.toThrow("HTTP 502");
    expect(f.calls).toHaveLength(2);
  });

  it("fails when Cloudflare answers 200 without success (twice)", async () => {
    const f = fakeFetch([{ status: 200, success: false }]);
    await expect(
      createDeliveryPurge({ zoneId: "z", apiToken: "t", fetch: f.fn }).purge(
        KEY,
      ),
    ).rejects.toThrow("HTTP 200");
    expect(f.calls).toHaveLength(2);
  });

  it("counts a timed-out attempt as failed and retries it once", async () => {
    let calls = 0;
    const hangOnce = ((_url: string, init: RequestInit) => {
      calls++;
      if (calls > 1) {
        return Promise.resolve(
          new Response(JSON.stringify({ success: true }), { status: 200 }),
        );
      }
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(init.signal?.reason),
        );
      });
    }) as unknown as typeof fetch;
    await createDeliveryPurge({
      zoneId: "z",
      apiToken: "t",
      fetch: hangOnce,
      timeoutMs: 20,
    }).purge(KEY);
    expect(calls).toBe(2);
  });

  it("fails when both attempts time out: exactly two calls", async () => {
    let calls = 0;
    const hanging = ((_url: string, init: RequestInit) => {
      calls++;
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(init.signal?.reason),
        );
      });
    }) as unknown as typeof fetch;
    await expect(
      createDeliveryPurge({
        zoneId: "z",
        apiToken: "t",
        fetch: hanging,
        timeoutMs: 20,
      }).purge(KEY),
    ).rejects.toThrow("timed out after 20 ms");
    expect(calls).toBe(2);
  });

  it("bounds each attempt with a timeout signal by default", async () => {
    const f = fakeFetch([{ status: 200, success: true }]);
    await createDeliveryPurge({
      zoneId: "z",
      apiToken: "t",
      fetch: f.fn,
    }).purge(KEY);
    expect(f.calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("skips with a warning when unconfigured", async () => {
    const warnings: string[] = [];
    const f = fakeFetch([{ status: 200, success: true }]);
    await createDeliveryPurge({
      zoneId: undefined,
      apiToken: "t",
      fetch: f.fn,
      warn: (m) => warnings.push(m),
    }).purge(KEY);
    expect(f.calls).toHaveLength(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("not configured");
    expect(warnings[0]).toContain(KEY);
  });
});
