import { describe, expect, it } from "bun:test";
import { proxyDaemonWithRetry } from "./daemon-proxy";

const DAEMON = { url: "http://127.0.0.1:1", token: "t" };
const init = { method: "GET", headers: new Headers(), body: null };

describe("proxyDaemonWithRetry", () => {
  it("rethrows the original fetch failure when re-resolving also fails", async () => {
    const original = await proxyDaemonWithRetry(DAEMON, "/x", init, {
      unauthorized: async () => null,
      unreachable: async () => {
        throw new Error("control plane unreachable too");
      },
    }).catch((err: unknown) => err);
    expect(original).toBeInstanceOf(Error);
    expect((original as Error).message).not.toBe(
      "control plane unreachable too",
    );
  });

  it("retries with the freshly resolved daemon on an unreachable address", async () => {
    let resolved = false;
    const fresh = { url: "http://127.0.0.1:1", token: "fresh" };
    const result = await proxyDaemonWithRetry(DAEMON, "/x", init, {
      unauthorized: async () => null,
      unreachable: async () => {
        if (resolved) return null;
        resolved = true;
        return fresh;
      },
    }).catch((err: unknown) => err);
    expect(resolved).toBe(true);
    expect(result).toBeInstanceOf(Error);
  });
});
