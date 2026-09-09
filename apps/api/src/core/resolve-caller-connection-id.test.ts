import { describe, expect, it } from "bun:test";
import { resolveCallerConnectionId } from "./context-factory";

describe("resolveCallerConnectionId", () => {
  it("prefers the JWT-verified connectionId over a client-set x-caller-id header", () => {
    const req = new Request("https://studio.test", {
      headers: { "x-caller-id": "conn_attacker" },
    });
    expect(
      resolveCallerConnectionId(req, { connectionId: "conn_verified" }),
    ).toBe("conn_verified");
  });

  it("falls back to the header when there is no authenticated connectionId", () => {
    const req = new Request("https://studio.test", {
      headers: { "x-caller-id": "conn_fallback" },
    });
    expect(resolveCallerConnectionId(req, undefined)).toBe("conn_fallback");
  });

  it("returns undefined with no request and no authenticated connectionId", () => {
    expect(resolveCallerConnectionId(undefined, undefined)).toBeUndefined();
  });
});
