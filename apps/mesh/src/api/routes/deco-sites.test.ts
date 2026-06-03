import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { StudioContext } from "../../core/studio-context";
import type { FileConfigInfo } from "../../storage/types";
import {
  provisionDecoAssetsCredentials,
  provisionDecoAssetsFileConfig,
} from "./deco-sites";

const originalFetch = globalThis.fetch;

function fetchOk(body: unknown): typeof globalThis.fetch {
  return mock(() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ),
  ) as unknown as typeof globalThis.fetch;
}

function fetchFail(status: number, body = ""): typeof globalThis.fetch {
  return mock(() =>
    Promise.resolve(new Response(body, { status })),
  ) as unknown as typeof globalThis.fetch;
}

function makeCtx(existing: FileConfigInfo[] = []): {
  ctx: StudioContext;
  createCalls: Array<Record<string, unknown>>;
} {
  const createCalls: Array<Record<string, unknown>> = [];
  const orgFileConfigs = {
    list: async (_orgId: string) => existing,
    create: async (input: Record<string, unknown>) => {
      createCalls.push(input);
      return {} as FileConfigInfo;
    },
  };
  const ctx = {
    storage: { orgFileConfigs },
  } as unknown as StudioContext;
  return { ctx, createCalls };
}

describe("provisionDecoAssetsCredentials", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("returns credentials on 200", async () => {
    globalThis.fetch = fetchOk({
      accessKeyId: "GOOG1ETEST",
      secretAccessKey: "secretvalue",
    });
    const result = await provisionDecoAssetsCredentials("acme", "api-key");
    expect(result).toEqual({
      accessKeyId: "GOOG1ETEST",
      secretAccessKey: "secretvalue",
    });
  });

  test("returns null on non-2xx", async () => {
    globalThis.fetch = fetchFail(401, "Unauthorized");
    const result = await provisionDecoAssetsCredentials("acme", "api-key");
    expect(result).toBeNull();
  });

  test("returns null on malformed response", async () => {
    globalThis.fetch = fetchOk({ accessKeyId: "GOOG1E" }); // missing secret
    const result = await provisionDecoAssetsCredentials("acme", "api-key");
    expect(result).toBeNull();
  });

  test("returns null when fetch throws", async () => {
    globalThis.fetch = mock(() =>
      Promise.reject(new Error("network down")),
    ) as unknown as typeof globalThis.fetch;
    const result = await provisionDecoAssetsCredentials("acme", "api-key");
    expect(result).toBeNull();
  });
});

describe("provisionDecoAssetsFileConfig", () => {
  let restoreFetch: () => void;

  beforeEach(() => {
    restoreFetch = () => {
      globalThis.fetch = originalFetch;
    };
  });
  afterEach(() => restoreFetch());

  test("creates a file config with the expected shape", async () => {
    globalThis.fetch = fetchOk({
      accessKeyId: "GOOG1ETEST",
      secretAccessKey: "secretvalue",
    });
    const { ctx, createCalls } = makeCtx();

    await provisionDecoAssetsFileConfig({
      ctx,
      orgId: "org_1",
      userId: "user_1",
      siteName: "acme",
      serviceAccountApiKey: "api-key",
    });

    expect(createCalls).toHaveLength(1);
    const created = createCalls[0]!;
    expect(created).toMatchObject({
      organizationId: "org_1",
      createdBy: "user_1",
      name: "deco-assets-acme",
      bucket: "deco-assets",
      region: "auto",
      endpoint: "https://storage.googleapis.com",
      forcePathStyle: true,
      prefix: "acme/",
      publicUrlBase: "https://decoims.com",
      credentials: {
        accessKeyId: "GOOG1ETEST",
        secretAccessKey: "secretvalue",
      },
    });
  });

  test("is idempotent: skips when a file config with the same name already exists", async () => {
    const fetchSpy = fetchOk({
      accessKeyId: "GOOG1ETEST",
      secretAccessKey: "secretvalue",
    });
    globalThis.fetch = fetchSpy;
    const { ctx, createCalls } = makeCtx([
      {
        id: "fcfg_existing",
        organizationId: "org_1",
        name: "deco-assets-acme",
        description: null,
        bucket: "deco-assets",
        region: "auto",
        endpoint: "https://storage.googleapis.com",
        forcePathStyle: true,
        prefix: "acme/",
        publicUrlBase: "https://decoims.com",
        createdBy: "user_1",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedBy: "user_1",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    await provisionDecoAssetsFileConfig({
      ctx,
      orgId: "org_1",
      userId: "user_1",
      siteName: "acme",
      serviceAccountApiKey: "api-key",
    });

    expect(createCalls).toHaveLength(0);
    // No HTTP call either — we short-circuit before hitting admin.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("name match is case-insensitive (matches DB unique index)", async () => {
    globalThis.fetch = fetchOk({
      accessKeyId: "X",
      secretAccessKey: "Y",
    });
    const { ctx, createCalls } = makeCtx([
      {
        id: "fcfg_existing",
        organizationId: "org_1",
        name: "DECO-ASSETS-ACME",
        description: null,
        bucket: "deco-assets",
        region: "auto",
        endpoint: "https://storage.googleapis.com",
        forcePathStyle: true,
        prefix: "acme/",
        publicUrlBase: "https://decoims.com",
        createdBy: "user_1",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedBy: "user_1",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    await provisionDecoAssetsFileConfig({
      ctx,
      orgId: "org_1",
      userId: "user_1",
      siteName: "acme",
      serviceAccountApiKey: "api-key",
    });

    expect(createCalls).toHaveLength(0);
  });

  test("does not create when credentials provisioning fails", async () => {
    globalThis.fetch = fetchFail(403, "Forbidden");
    const { ctx, createCalls } = makeCtx();

    await provisionDecoAssetsFileConfig({
      ctx,
      orgId: "org_1",
      userId: "user_1",
      siteName: "acme",
      serviceAccountApiKey: "api-key",
    });

    expect(createCalls).toHaveLength(0);
  });
});
