import { describe, expect, it } from "bun:test";
import {
  isUplinkWsData,
  parseUplinkBearer,
  tryUpgradeUplinkWs,
  UPLINK_KEEPALIVE_MS,
  UPLINK_PATH,
} from "./uplink-ws";

function req(headers: Record<string, string>, path = UPLINK_PATH): Request {
  return new Request(`http://x${path}`, { headers });
}

describe("parseUplinkBearer", () => {
  it("reads Authorization: Bearer", () => {
    expect(
      parseUplinkBearer(
        req({ upgrade: "websocket", authorization: "Bearer t1" }),
      ),
    ).toBe("t1");
  });
  it("falls back to Sec-WebSocket-Protocol (bearer.<token>)", () => {
    expect(
      parseUplinkBearer(
        req({ upgrade: "websocket", "sec-websocket-protocol": "bearer.t2" }),
      ),
    ).toBe("t2");
  });
  it("trims whitespace", () => {
    expect(
      parseUplinkBearer(
        req({ upgrade: "websocket", authorization: "Bearer  t3  " }),
      ),
    ).toBe("t3");
  });
  it("returns null when no bearer is present", () => {
    expect(parseUplinkBearer(req({ upgrade: "websocket" }))).toBeNull();
  });
});

describe("isUplinkWsData", () => {
  it("guards the carrier shape", () => {
    expect(isUplinkWsData({ kind: "uplink", userSub: "u" })).toBe(true);
    expect(isUplinkWsData({ kind: "preview" })).toBe(false);
    expect(isUplinkWsData(null)).toBe(false);
    expect(isUplinkWsData({})).toBe(false);
  });
});

describe("tryUpgradeUplinkWs", () => {
  let capturedData: unknown = null;
  function fakeServer(ok: boolean) {
    return {
      upgrade(_request: Request, opts: { data: unknown }) {
        capturedData = opts.data;
        return ok;
      },
    };
  }

  it("ignores non-WS requests (returns null → caller falls through)", async () => {
    const res = await tryUpgradeUplinkWs(
      new Request("http://x/api/links/uplink", { headers: {} }),
      fakeServer(true) as never,
      { resolve: async () => "user_1" },
    );
    expect(res).toBeNull();
  });

  it("ignores non-uplink paths", async () => {
    const res = await tryUpgradeUplinkWs(
      req({ upgrade: "websocket" }, "/api/other"),
      fakeServer(true) as never,
      { resolve: async () => "user_1" },
    );
    expect(res).toBeNull();
  });

  it("rejects with 401 when no bearer is present", async () => {
    const res = await tryUpgradeUplinkWs(
      req({ upgrade: "websocket" }),
      fakeServer(true) as never,
      { resolve: async () => "user_1" },
    );
    expect((res as Response).status).toBe(401);
  });

  it("rejects with 401 when the bearer does not resolve", async () => {
    const res = await tryUpgradeUplinkWs(
      req({ upgrade: "websocket", authorization: "Bearer bad" }),
      fakeServer(true) as never,
      { resolve: async () => null },
    );
    expect((res as Response).status).toBe(401);
  });

  it("rejects with 426 when the upgrade fails", async () => {
    const res = await tryUpgradeUplinkWs(
      req({ upgrade: "websocket", authorization: "Bearer good" }),
      fakeServer(false) as never,
      { resolve: async () => "user_9" },
    );
    expect((res as Response).status).toBe(426);
  });

  it("upgrades with an uplink carrier carrying the resolved userSub", async () => {
    capturedData = null;
    const res = await tryUpgradeUplinkWs(
      req({ upgrade: "websocket", authorization: "Bearer good" }),
      fakeServer(true) as never,
      { resolve: async () => "user_9" },
    );
    expect(res).toBeUndefined(); // upgraded
    expect(isUplinkWsData(capturedData)).toBe(true);
    expect((capturedData as { userSub: string }).userSub).toBe("user_9");
  });

  it("keepalive interval stays under the 350s NLB idle", () => {
    expect(UPLINK_KEEPALIVE_MS).toBeLessThan(350_000);
  });
});
