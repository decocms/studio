import { afterEach, describe, expect, it, mock } from "bun:test";
import { KEYS } from "@/lib/query-keys";
import type { LiveMeta } from "./resolve-schema";
import {
  fetchLiveMeta,
  liveMetaQueryKey,
  metaSourceOrder,
} from "./use-live-meta";

const PREVIEW = "https://sandbox.example.deco.host";
const PROD = "https://www.example.com";

describe("metaSourceOrder", () => {
  it("dev up: live → committed → production", () => {
    expect(
      metaSourceOrder({
        fetchEnabled: true,
        previewUrl: PREVIEW,
        productionUrl: PROD,
        fastPreviewActive: false,
      }),
    ).toEqual([
      { kind: "live", baseUrl: PREVIEW },
      { kind: "committed" },
      { kind: "production", baseUrl: PROD },
    ]);
  });

  it("dev down: committed → production (no live attempt)", () => {
    expect(
      metaSourceOrder({
        fetchEnabled: false,
        previewUrl: PREVIEW,
        productionUrl: PROD,
        fastPreviewActive: false,
      }),
    ).toEqual([{ kind: "committed" }, { kind: "production", baseUrl: PROD }]);
  });

  it("no previewUrl yet: skips live even when fetchEnabled", () => {
    expect(
      metaSourceOrder({
        fetchEnabled: true,
        previewUrl: null,
        productionUrl: PROD,
        fastPreviewActive: false,
      }),
    ).toEqual([{ kind: "committed" }, { kind: "production", baseUrl: PROD }]);
  });

  it("dev up, no production: live → committed (no production tier)", () => {
    expect(
      metaSourceOrder({
        fetchEnabled: true,
        previewUrl: PREVIEW,
        productionUrl: null,
        fastPreviewActive: false,
      }),
    ).toEqual([{ kind: "live", baseUrl: PREVIEW }, { kind: "committed" }]);
  });

  it("no production configured: committed is the only fallback", () => {
    expect(
      metaSourceOrder({
        fetchEnabled: false,
        previewUrl: PREVIEW,
        productionUrl: null,
        fastPreviewActive: false,
      }),
    ).toEqual([{ kind: "committed" }]);
  });

  it("committed always precedes production (branch-accurate wins)", () => {
    const order = metaSourceOrder({
      fetchEnabled: true,
      previewUrl: PREVIEW,
      productionUrl: PROD,
      fastPreviewActive: false,
    });
    const committedIdx = order.findIndex((s) => s.kind === "committed");
    const productionIdx = order.findIndex((s) => s.kind === "production");
    expect(committedIdx).toBeLessThan(productionIdx);
  });

  it("fast preview: committed (via git) → production, never live", () => {
    expect(
      metaSourceOrder({
        fetchEnabled: true,
        previewUrl: PREVIEW,
        productionUrl: PROD,
        fastPreviewActive: true,
      }),
    ).toEqual([{ kind: "committed" }, { kind: "production", baseUrl: PROD }]);
  });

  it("fast preview, no production: committed is the only source", () => {
    expect(
      metaSourceOrder({
        fetchEnabled: true,
        previewUrl: PREVIEW,
        productionUrl: null,
        fastPreviewActive: true,
      }),
    ).toEqual([{ kind: "committed" }]);
  });
});

describe("liveMetaQueryKey", () => {
  const params = {
    orgSlug: "acme",
    virtualMcpId: "vmid-1",
    branch: "feature-branch",
  };

  // The sandbox lifecycle invalidates live meta with the (org, vmid, branch)
  // prefix when the dev server comes up. If the head of this key ever stops
  // matching that prefix, the invalidation silently no-ops and the CMS keeps
  // rendering forms from the committed/production schema for the whole
  // session — on a Deno site (no committed meta.gen.json) that means the
  // form shows main's fields, not the branch's.
  it("keeps KEYS.liveMeta(org, vmid, branch) as a prefix", () => {
    const key = liveMetaQueryKey({
      ...params,
      previewUrl: PREVIEW,
      productionUrl: PROD,
    });
    const scope = KEYS.liveMeta(
      params.orgSlug,
      params.virtualMcpId,
      params.branch,
    );
    expect(key.slice(0, scope.length)).toEqual([...scope]);
  });

  it("keeps the prefix when no URLs are known yet", () => {
    const key = liveMetaQueryKey(params);
    const scope = KEYS.liveMeta(
      params.orgSlug,
      params.virtualMcpId,
      params.branch,
    );
    expect(key.slice(0, scope.length)).toEqual([...scope]);
  });

  it("varies by URL tail so a settings edit re-fetches", () => {
    expect(liveMetaQueryKey({ ...params, productionUrl: PROD })).not.toEqual(
      liveMetaQueryKey({ ...params, productionUrl: "https://other.example" }),
    );
  });
});

describe("fetchLiveMeta", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const held: LiveMeta = {
    manifest: { blocks: {} },
    schema: { definitions: {} },
    etag: '"meta-old"',
  };
  const fresh: LiveMeta = {
    manifest: { blocks: {} },
    schema: { definitions: { Banner: {} } },
    etag: '"meta-new"',
  };

  function stubFetch(answer: () => Promise<Response>) {
    const calls: RequestInit[] = [];
    globalThis.fetch = mock(
      (_url: string | URL | Request, init?: RequestInit) => {
        calls.push(init ?? {});
        return answer();
      },
    ) as unknown as typeof fetch;
    return calls;
  }

  it("first read: plain GET, no conditional header", async () => {
    const calls = stubFetch(async () => Response.json(fresh));
    expect(await fetchLiveMeta(PREVIEW)).toEqual(fresh);
    expect(calls[0]?.headers).toEqual({});
  });

  it("revalidates the held schema with its etag; 304 keeps it", async () => {
    const calls = stubFetch(async () => new Response(null, { status: 304 }));
    expect(await fetchLiveMeta(PREVIEW, held)).toBe(held);
    expect(calls[0]?.headers).toEqual({ "If-None-Match": '"meta-old"' });
  });

  it("a changed schema replaces the held one", async () => {
    stubFetch(async () => Response.json(fresh));
    expect(await fetchLiveMeta(PREVIEW, held)).toEqual(fresh);
  });

  it("held schema without an etag: plain GET", async () => {
    const calls = stubFetch(async () => Response.json(fresh));
    await fetchLiveMeta(PREVIEW, { ...held, etag: undefined });
    expect(calls[0]?.headers).toEqual({});
  });

  it("a rejected revalidation (older dev server's CORS) keeps the held schema", async () => {
    stubFetch(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await fetchLiveMeta(PREVIEW, held)).toBe(held);
  });

  it("nothing held and no answer: null", async () => {
    stubFetch(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await fetchLiveMeta(PREVIEW)).toBeNull();
  });

  it("an HTML 200 (not a deco site) is no answer", async () => {
    stubFetch(async () => new Response("<!doctype html>", { status: 200 }));
    expect(await fetchLiveMeta(PREVIEW)).toBeNull();
  });

  it("a 5xx on revalidation is no answer", async () => {
    stubFetch(async () => new Response("down", { status: 502 }));
    expect(await fetchLiveMeta(PREVIEW, held)).toBeNull();
  });
});
