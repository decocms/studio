import { describe, expect, mock, test } from "bun:test";
import {
  DEV_LINK_TOXIPROXY_PROXY_NAME,
  DEV_LINK_TOXIPROXY_SERVICE_NAME,
  buildDevLinkToxiProxyConfig,
  ensureDevLinkToxiProxy,
  isDevLinkToxiProxyEnabled,
  populateDevLinkToxiProxy,
} from "./dev-link-toxiproxy";

describe("dev-link-toxiproxy config", () => {
  test("env flag is enabled only by literal 1", () => {
    expect(isDevLinkToxiProxyEnabled({ DECO_DEV_LINK_TOXIPROXY: "1" })).toBe(
      true,
    );
    expect(isDevLinkToxiProxyEnabled({ DECO_DEV_LINK_TOXIPROXY: "true" })).toBe(
      false,
    );
    expect(isDevLinkToxiProxyEnabled({})).toBe(false);
  });

  test("exports the TUI service name exactly as ToxiProxy", () => {
    expect(DEV_LINK_TOXIPROXY_SERVICE_NAME).toBe("ToxiProxy");
    expect(DEV_LINK_TOXIPROXY_PROXY_NAME).toBe("dev_link_studio");
  });

  test("builds a localhost proxy config for an http Studio URL", () => {
    const config = buildDevLinkToxiProxyConfig({
      serverUrl: "http://localhost:4001",
      apiPort: 18474,
      listenPort: 18480,
    });

    expect(config).toEqual({
      serviceName: "ToxiProxy",
      proxyName: "dev_link_studio",
      apiUrl: "http://127.0.0.1:18474",
      listen: "0.0.0.0:18480",
      upstream: "host.docker.internal:4001",
      publicTargetUrl: "http://127.0.0.1:4001",
      clusterUrl: "http://127.0.0.1:18480",
      logLine:
        "[dev-link-toxiproxy] ready: http://127.0.0.1:18480 -> http://127.0.0.1:4001",
    });
  });

  test("rejects https because local dev-link proxying assumes http", () => {
    expect(() =>
      buildDevLinkToxiProxyConfig({
        serverUrl: "https://localhost:4001",
        apiPort: 18474,
        listenPort: 18480,
      }),
    ).toThrow(/only supports http local Studio URLs/);
  });

  test("rejects invalid api ports", () => {
    expect(() =>
      buildDevLinkToxiProxyConfig({
        serverUrl: "http://localhost:4001",
        apiPort: 0,
        listenPort: 18480,
      }),
    ).toThrow(/apiPort must be an integer port in 1\.\.65535/);
  });

  test("rejects invalid listen ports", () => {
    expect(() =>
      buildDevLinkToxiProxyConfig({
        serverUrl: "http://localhost:4001",
        apiPort: 18474,
        listenPort: 65536,
      }),
    ).toThrow(/listenPort must be an integer port in 1\.\.65535/);
  });

  test("rejects server URLs without an explicit port", () => {
    expect(() =>
      buildDevLinkToxiProxyConfig({
        serverUrl: "http://localhost",
        apiPort: 18474,
        listenPort: 18480,
      }),
    ).toThrow(/serverUrl must include an explicit valid port/);
  });

  test("rejects invalid server URL ports", () => {
    expect(() =>
      buildDevLinkToxiProxyConfig({
        serverUrl: "http://localhost:0",
        apiPort: 18474,
        listenPort: 18480,
      }),
    ).toThrow(/upstreamPort must be an integer port in 1\.\.65535/);
  });
});

describe("dev-link-toxiproxy HTTP API", () => {
  test("resets then populates the configured proxy", async () => {
    const config = buildDevLinkToxiProxyConfig({
      serverUrl: "http://localhost:4001",
      apiPort: 18474,
      listenPort: 18480,
    });
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = mock(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;

    await populateDevLinkToxiProxy(config, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(calls[0]).toEqual({
      url: "http://127.0.0.1:18474/reset",
      init: { method: "POST" },
    });
    expect(calls[1]?.url).toBe("http://127.0.0.1:18474/populate");
    expect(calls[1]?.init?.method).toBe("POST");
    expect(calls[1]?.init?.headers).toEqual({
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual([
      {
        name: "dev_link_studio",
        listen: "0.0.0.0:18480",
        upstream: "host.docker.internal:4001",
        enabled: true,
      },
    ]);
  });

  test("includes response body when ToxiProxy returns a non-ok response", async () => {
    const config = buildDevLinkToxiProxyConfig({
      serverUrl: "http://localhost:4001",
      apiPort: 18474,
      listenPort: 18480,
    });
    const fetchImpl = mock(async () => {
      return new Response("bad proxy", {
        status: 500,
        statusText: "Internal Server Error",
      });
    }) as unknown as typeof fetch;

    await expect(populateDevLinkToxiProxy(config, fetchImpl)).rejects.toThrow(
      /reset.*500.*Internal Server Error.*bad proxy/s,
    );
  });

  test("starts the daemon, populates ToxiProxy, and returns config", async () => {
    const startDaemon = mock(async () => {});
    const fetchImpl = mock(async () => {
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;

    const config = await ensureDevLinkToxiProxy({
      serverUrl: "http://localhost:4001",
      apiPort: 18474,
      listenPort: 18480,
      startDaemon,
      fetchImpl,
    });

    expect(startDaemon).toHaveBeenCalledWith(18474, 18480);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(config.clusterUrl).toBe("http://127.0.0.1:18480");
  });
});
