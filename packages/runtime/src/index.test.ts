import { describe, expect, test } from "bun:test";
import {
  type DefaultEnv,
  type RequestContext,
  withBindings,
  withRuntime,
} from "./index.ts";
import { createMCPServer } from "./tools.ts";

const encodeJwtPart = (value: unknown) =>
  btoa(JSON.stringify(value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

const tokenFor = (payload: Record<string, unknown>) =>
  `${encodeJwtPart({ alg: "none" })}.${encodeJwtPart(payload)}.signature`;

type TestEnv = DefaultEnv<never>;

const placeholderContext = {} as RequestContext<never>;

const createEnv = (overrides: Partial<TestEnv> = {}): TestEnv => ({
  STUDIO_REQUEST_CONTEXT: placeholderContext,
  MESH_REQUEST_CONTEXT: placeholderContext,
  STUDIO_APP_DEPLOYMENT_ID: "deployment",
  MESH_APP_DEPLOYMENT_ID: "deployment",
  IS_LOCAL: false,
  ...overrides,
});

describe("withBindings Studio aliases", () => {
  test("publishes both request-context keys with Studio URL precedence", () => {
    const result = withBindings({
      env: {
        STUDIO_REQUEST_CONTEXT: placeholderContext,
        STUDIO_APP_DEPLOYMENT_ID: "deployment",
        IS_LOCAL: false,
      },
      server: createMCPServer({}),
      tokenOrContext: tokenFor({
        studioUrl: "https://studio.example.com",
        meshUrl: "https://legacy.example.com",
        state: {},
      }),
    });

    expect(result.STUDIO_REQUEST_CONTEXT).toBe(result.MESH_REQUEST_CONTEXT);
    expect(result.STUDIO_REQUEST_CONTEXT.studioUrl).toBe(
      "https://studio.example.com",
    );
    expect(result.STUDIO_REQUEST_CONTEXT.meshUrl).toBe(
      "https://studio.example.com",
    );
  });

  test("accepts legacy JWT metadata and mirrors canonical env values", () => {
    const env = createEnv({
      STUDIO_APP_DEPLOYMENT_ID: "studio-deployment",
      MESH_APP_DEPLOYMENT_ID: "legacy-deployment",
      STUDIO_URL: "https://studio-env.example.com",
      MESH_URL: "https://legacy-env.example.com",
      STUDIO_RUNTIME_TOKEN: "studio-token",
      MESH_RUNTIME_TOKEN: "legacy-token",
      STUDIO_APP_NAME: "studio-app",
      MESH_APP_NAME: "legacy-app",
    });
    const result = withBindings({
      env,
      server: createMCPServer({}),
      tokenOrContext: tokenFor({
        metadata: {
          meshUrl: "https://legacy.example.com",
          state: {},
        },
      }),
    });

    expect(result.STUDIO_REQUEST_CONTEXT.studioUrl).toBe(
      "https://legacy.example.com",
    );
    expect(result.STUDIO_REQUEST_CONTEXT.meshUrl).toBe(
      "https://legacy.example.com",
    );
    expect(result.STUDIO_APP_DEPLOYMENT_ID).toBe("studio-deployment");
    expect(result.MESH_APP_DEPLOYMENT_ID).toBe("studio-deployment");
    expect(result.STUDIO_URL).toBe("https://studio-env.example.com");
    expect(result.MESH_URL).toBe("https://studio-env.example.com");
    expect(result.STUDIO_RUNTIME_TOKEN).toBe("studio-token");
    expect(result.MESH_RUNTIME_TOKEN).toBe("studio-token");
    expect(result.STUDIO_APP_NAME).toBe("studio-app");
    expect(result.MESH_APP_NAME).toBe("studio-app");
  });

  test("accepts a request-context object with only meshUrl", () => {
    const result = withBindings({
      env: {
        MESH_REQUEST_CONTEXT: placeholderContext,
        MESH_APP_DEPLOYMENT_ID: "legacy-deployment",
        IS_LOCAL: false,
      },
      server: createMCPServer({}),
      tokenOrContext: {
        state: {},
        token: tokenFor({}),
        meshUrl: "https://legacy.example.com",
        ensureAuthenticated: () => undefined,
      },
    });

    expect(result.STUDIO_REQUEST_CONTEXT.studioUrl).toBe(
      "https://legacy.example.com",
    );
    expect(result.STUDIO_REQUEST_CONTEXT.meshUrl).toBe(
      "https://legacy.example.com",
    );
    expect(result.STUDIO_APP_DEPLOYMENT_ID).toBe("legacy-deployment");
    expect(result.MESH_APP_DEPLOYMENT_ID).toBe("legacy-deployment");
  });
});

describe("withRuntime Studio headers", () => {
  test("prefers x-studio-token over the legacy wire header", async () => {
    const studioToken = tokenFor({
      studioUrl: "https://studio.example.com",
      state: {},
    });
    const legacyToken = tokenFor({
      meshUrl: "https://legacy.example.com",
      state: {},
    });
    const runtime = withRuntime({
      fetch: (_request, env) =>
        Response.json({
          token: env.STUDIO_REQUEST_CONTEXT.token,
          studioUrl: env.STUDIO_REQUEST_CONTEXT.studioUrl,
        }),
    });

    const response = await runtime.fetch(
      new Request("https://runtime.example.com/custom", {
        headers: {
          "x-studio-token": studioToken,
          "x-mesh-token": legacyToken,
        },
      }),
      { IS_LOCAL: false },
    );

    const body = (await response.json()) as {
      token: string;
      studioUrl: string;
    };
    expect(body).toEqual({
      token: studioToken,
      studioUrl: "https://studio.example.com",
    });
  });
});

describe("withRuntime with secrets left out of the token", () => {
  const runtime = withRuntime({
    fetch: (_request, env) =>
      Response.json({ state: env.STUDIO_REQUEST_CONTEXT.state }),
  });
  const call = (payload: Record<string, unknown>, env = {}) =>
    runtime.fetch(
      new Request("https://runtime.example.com/custom", {
        headers: { "x-studio-token": tokenFor(payload) },
      }),
      { IS_LOCAL: false, ...env },
    );
  const metadata = {
    state: { accountName: "store" },
    stateHash: "hash",
    stateProof: "proof",
    connectionId: "conn_1",
    organizationSlug: "acme",
    studioUrl: "https://studio.example.com",
  };

  test("serves the state Studio returns for the token", async () => {
    const realFetch = globalThis.fetch;
    const asked: string[] = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      asked.push(`${url} ${new Headers(init.headers).get("authorization")}`);
      return Response.json({
        state: { accountName: "store", appToken: "from-studio" },
        proofKey: "key",
      });
    }) as unknown as typeof fetch;
    try {
      const token = { metadata, exp: Math.floor(Date.now() / 1000) + 60 };
      const response = await call(token, {
        STUDIO_TRUSTED_URLS: "https://studio.example.com",
      });
      expect((await response.json()) as unknown).toEqual({
        state: { accountName: "store", appToken: "from-studio" },
      });
      expect(asked).toEqual([
        `https://studio.example.com/api/acme/vault/connections/conn_1/configuration Bearer ${tokenFor(token)}`,
      ]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("answers 401 without asking a Studio it does not trust", async () => {
    const response = await call({
      metadata,
      exp: Math.floor(Date.now() / 1000) + 60,
    });
    expect(response.status).toBe(401);
  });

  test("keeps using the token's state when nothing was left out", async () => {
    const response = await call({
      metadata: { ...metadata, stateHash: undefined, stateProof: undefined },
    });
    expect((await response.json()) as unknown).toEqual({
      state: { accountName: "store" },
    });
  });
});
