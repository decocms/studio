import { describe, expect, test } from "bun:test";
import {
  DEV_LINK_TOXIPROXY_PROXY_NAME,
  DEV_LINK_TOXIPROXY_SERVICE_NAME,
  buildDevLinkToxiProxyConfig,
  isDevLinkToxiProxyEnabled,
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
