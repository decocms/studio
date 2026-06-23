import { describe, expect, it } from "bun:test";
import {
  buildDevNatsToxiProxyConfig,
  ensureDevNatsToxiProxy,
  isDevNatsToxiProxyEnabled,
} from "./dev-nats-toxiproxy";

describe("isDevNatsToxiProxyEnabled", () => {
  it("is gated on DECO_DEV_NATS_TOXIPROXY=1", () => {
    expect(isDevNatsToxiProxyEnabled({})).toBe(false);
    expect(isDevNatsToxiProxyEnabled({ DECO_DEV_NATS_TOXIPROXY: "0" })).toBe(
      false,
    );
    expect(isDevNatsToxiProxyEnabled({ DECO_DEV_NATS_TOXIPROXY: "1" })).toBe(
      true,
    );
  });
});

describe("buildDevNatsToxiProxyConfig", () => {
  it("proxies the daemon NATS URL to a listener fronting the host NATS port", () => {
    const config = buildDevNatsToxiProxyConfig({ natsPort: 57917 });
    // Daemon dials the proxy on loopback...
    expect(config.publicUrl).toBe("nats://127.0.0.1:18482");
    expect(config.listen).toBe("0.0.0.0:18482");
    // ...which forwards to the host's NATS via host.docker.internal.
    expect(config.upstream).toBe("host.docker.internal:57917");
    expect(config.apiUrl).toBe("http://127.0.0.1:18475");
    expect(config.proxyName).toBe("dev_nats");
    expect(config.containerName).toBe("deco-dev-nats-toxiproxy-18475");
  });

  it("honors custom api/listen ports", () => {
    const config = buildDevNatsToxiProxyConfig({
      natsPort: 4222,
      apiPort: 28475,
      listenPort: 28482,
    });
    expect(config.publicUrl).toBe("nats://127.0.0.1:28482");
    expect(config.upstream).toBe("host.docker.internal:4222");
    expect(config.apiUrl).toBe("http://127.0.0.1:28475");
  });

  it("rejects invalid ports", () => {
    expect(() => buildDevNatsToxiProxyConfig({ natsPort: 0 })).toThrow(
      "natsPort",
    );
    expect(() =>
      buildDevNatsToxiProxyConfig({ natsPort: 4222, listenPort: 70000 }),
    ).toThrow("listenPort");
  });
});

describe("ensureDevNatsToxiProxy", () => {
  it("starts the proxy and populates it with the dev_nats route", async () => {
    let started = false;
    const populated: unknown[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/version")) {
        return new Response("2.12.0", { status: 200 });
      }
      if (String(url).endsWith("/populate")) {
        populated.push(JSON.parse(String(init?.body)));
        return new Response("{}", { status: 201 });
      }
      return new Response("", { status: 404 });
    }) as typeof fetch;

    const handle = await ensureDevNatsToxiProxy({
      natsPort: 57917,
      startDaemon: async () => {
        started = true;
      },
      fetchImpl,
    });

    expect(started).toBe(true);
    expect(handle.config.publicUrl).toBe("nats://127.0.0.1:18482");
    expect(populated).toEqual([
      [
        {
          name: "dev_nats",
          listen: "0.0.0.0:18482",
          upstream: "host.docker.internal:57917",
          enabled: true,
        },
      ],
    ]);
  });

  it("tears down the daemon if populate fails", async () => {
    let stopped = false;
    const fetchImpl = (async (url: string) => {
      if (String(url).endsWith("/version")) {
        return new Response("2.12.0", { status: 200 });
      }
      return new Response("boom", { status: 500 });
    }) as typeof fetch;

    await expect(
      ensureDevNatsToxiProxy({
        natsPort: 57917,
        startDaemon: async () => {},
        stopDaemon: async () => {
          stopped = true;
        },
        fetchImpl,
      }),
    ).rejects.toThrow("populate failed");
    expect(stopped).toBe(true);
  });
});
