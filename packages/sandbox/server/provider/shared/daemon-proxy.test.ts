import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { once } from "node:events";
import { type AddressInfo, createServer, type Server } from "node:net";
import {
  type DaemonAddress,
  isPreConnectFailure,
  proxyDaemonWithRetry,
} from "./daemon-proxy";

/** Port 1 on loopback refuses connections: the request never leaves. */
const REFUSED: DaemonAddress = { url: "http://127.0.0.1:1", token: "t" };

let live: ReturnType<typeof Bun.serve>;
let liveHits = 0;
/** Accepts, reads the request, then drops the socket: it reached the daemon. */
let resetting: Server;
let resettingUrl = "";
let resetDials = 0;

beforeAll(async () => {
  live = Bun.serve({
    port: 0,
    fetch: () => {
      liveHits++;
      return new Response("ok");
    },
  });
  resetting = createServer((socket) => {
    resetDials++;
    socket.on("data", () => socket.destroy());
  }).listen(0);
  await once(resetting, "listening");
  resettingUrl = `http://127.0.0.1:${(resetting.address() as AddressInfo).port}`;
});

afterAll(() => {
  live.stop(true);
  resetting.close();
});

const liveAddress = (): DaemonAddress => ({
  url: `http://127.0.0.1:${live.port}`,
  token: "t",
});

function request(method: string) {
  return {
    method,
    headers: new Headers(),
    body: method === "GET" ? null : "{}",
  };
}

function recover(fresh: DaemonAddress | null) {
  const seen: unknown[] = [];
  return {
    seen,
    reresolve: {
      unauthorized: async () => null,
      unreachable: async (err: unknown) => {
        seen.push(err);
        return fresh;
      },
    },
  };
}

describe("proxyDaemonWithRetry after a failed send", () => {
  it("resends a POST whose connection was refused to the re-read address", async () => {
    liveHits = 0;
    const { seen, reresolve } = recover(liveAddress());
    const resp = await proxyDaemonWithRetry(
      REFUSED,
      "/x",
      request("POST"),
      reresolve,
    );
    expect(resp.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(liveHits).toBe(1);
  });

  it("surfaces a POST that reached the daemon before the connection dropped", async () => {
    liveHits = 0;
    resetDials = 0;
    const { seen, reresolve } = recover(liveAddress());
    const err = await proxyDaemonWithRetry(
      { url: resettingUrl, token: "t" },
      "/x",
      request("POST"),
      reresolve,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(seen).toHaveLength(0);
    expect(resetDials).toBe(1);
    expect(liveHits).toBe(0);
  });

  it("resends an idempotent GET after a dropped connection", async () => {
    liveHits = 0;
    const { seen, reresolve } = recover(liveAddress());
    const resp = await proxyDaemonWithRetry(
      { url: resettingUrl, token: "t" },
      "/x",
      request("GET"),
      reresolve,
    );
    expect(resp.status).toBe(200);
    expect(seen).toHaveLength(1);
  });

  it("rethrows when the re-read has no other address", async () => {
    const { seen, reresolve } = recover(null);
    const err = await proxyDaemonWithRetry(
      REFUSED,
      "/x",
      request("POST"),
      reresolve,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(seen).toHaveLength(1);
  });

  it("does not retry a request the caller aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { seen, reresolve } = recover(liveAddress());
    const err = await proxyDaemonWithRetry(
      REFUSED,
      "/x",
      { ...request("GET"), signal: controller.signal },
      reresolve,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(seen).toHaveLength(0);
  });
});

describe("isPreConnectFailure", () => {
  it("reads DNS and refused-connection failures as pre-connect", () => {
    const dns = Object.assign(
      new Error("getaddrinfo ENOTFOUND sandbox.example.svc.cluster.local"),
      { code: "ENOTFOUND" },
    );
    expect(isPreConnectFailure(dns)).toBe(true);
    expect(
      isPreConnectFailure(new Error("getaddrinfo ENOTFOUND sandbox.example")),
    ).toBe(true);
    expect(
      isPreConnectFailure(
        Object.assign(new Error("fetch failed"), {
          cause: { code: "ECONNREFUSED" },
        }),
      ),
    ).toBe(true);
    expect(
      isPreConnectFailure(
        Object.assign(new Error("Unable to connect"), {
          code: "ConnectionRefused",
        }),
      ),
    ).toBe(true);
  });

  it("does not treat resets or timeouts as pre-connect", () => {
    expect(
      isPreConnectFailure(
        Object.assign(new Error("socket closed"), { code: "ECONNRESET" }),
      ),
    ).toBe(false);
    expect(
      isPreConnectFailure(
        Object.assign(new Error("The operation timed out."), {
          name: "TimeoutError",
        }),
      ),
    ).toBe(false);
  });
});
