import { describe, expect, test } from "bun:test";
import { createSecretModelSource, openMcpSource } from "./sources";
import type {
  DecopilotMcpSource,
  DecopilotModelSource,
  DecopilotSandboxSource,
  DecopilotHttpMcpSource,
  OpenMcpSourceOptions,
} from "./types";

describe("openMcpSource", () => {
  test("returns an in-process client and delegates close to the supplied hook", async () => {
    let closed = false;
    const client = { listTools: async () => ({ tools: [] }) };

    const opened = await openMcpSource({
      kind: "in-process",
      client,
      close: async () => {
        closed = true;
      },
    });

    expect(opened.client).toBe(client);
    await opened.close();
    expect(closed).toBe(true);
  });

  test("in-process source without close hook closes as a no-op", async () => {
    const client = { listTools: async () => ({ tools: [] }) };

    const opened = await openMcpSource({
      kind: "in-process",
      client,
    });

    expect(opened.client).toBe(client);
    await expect(opened.close()).resolves.toBeUndefined();
  });

  test("http source delegates to an HTTP opener", async () => {
    let closed = false;
    let receivedSource: DecopilotMcpSource | undefined;
    const client = { connect: async () => {} };
    const source: DecopilotMcpSource = {
      kind: "http",
      url: "http://127.0.0.1:9/mcp",
      headers: { authorization: "Bearer test" },
      expiresAt: Date.now() + 60_000,
    };
    const opened = await openMcpSource(source, {
      openHttp: async (nextSource) => {
        receivedSource = nextSource;
        return {
          client,
          close: async () => {
            closed = true;
          },
        };
      },
    });

    expect(receivedSource).toBe(source);
    expect(opened.client).toBe(client);
    await opened.close();
    expect(closed).toBe(true);
  });
});

describe("createSecretModelSource", () => {
  test("builds a plain secret model source", () => {
    expect(
      createSecretModelSource({
        providerId: "anthropic",
        apiKey: "sk-ant",
        modelId: "claude-3-5-sonnet",
      }),
    ).toEqual({
      kind: "secret",
      providerId: "anthropic",
      apiKey: "sk-ant",
      modelId: "claude-3-5-sonnet",
    });
  });

  test("unpacks openai-compatible JSON credentials", () => {
    expect(
      createSecretModelSource({
        providerId: "openai-compatible",
        apiKey: JSON.stringify({
          apiKey: "sk-litellm",
          baseUrl: "https://litellm.example.com/v1",
        }),
        modelId: "gpt-4.1",
      }),
    ).toEqual({
      kind: "secret",
      providerId: "openai-compatible",
      apiKey: "sk-litellm",
      modelId: "gpt-4.1",
      baseUrl: "https://litellm.example.com/v1",
    });
  });
});

test("Decopilot source types are exported from harness types", () => {
  const mcp: DecopilotMcpSource = {
    kind: "http",
    url: "http://127.0.0.1:9/mcp",
    headers: {},
    expiresAt: 1,
  };
  const httpMcp: DecopilotHttpMcpSource = mcp;
  const model: DecopilotModelSource = {
    kind: "secret",
    providerId: "openai",
    apiKey: "test",
    modelId: "gpt-test",
  };
  const sandbox: DecopilotSandboxSource = { kind: "none" };
  const options: OpenMcpSourceOptions = {};

  expect(mcp.kind).toBe("http");
  expect(httpMcp.kind).toBe("http");
  expect(model.kind).toBe("secret");
  expect(sandbox.kind).toBe("none");
  expect(options.openHttp).toBeUndefined();
});
