import { describe, expect, it } from "bun:test";
import {
  isVersionAcceptable,
  LINK_PROTOCOL_VERSION,
  LINK_PROTOCOL_UPGRADE_MESSAGE,
  MIN_SUPPORTED_LINK_PROTOCOL,
} from "./version";

describe("link protocol version", () => {
  it("exposes numeric constants with LINK >= MIN", () => {
    expect(typeof LINK_PROTOCOL_VERSION).toBe("number");
    expect(typeof MIN_SUPPORTED_LINK_PROTOCOL).toBe("number");
    expect(LINK_PROTOCOL_VERSION).toBeGreaterThanOrEqual(
      MIN_SUPPORTED_LINK_PROTOCOL,
    );
  });

  it("accepts MIN_SUPPORTED_LINK_PROTOCOL", () => {
    expect(isVersionAcceptable(MIN_SUPPORTED_LINK_PROTOCOL)).toBe(true);
  });

  it("accepts LINK_PROTOCOL_VERSION", () => {
    expect(isVersionAcceptable(LINK_PROTOCOL_VERSION)).toBe(true);
  });

  it("rejects MIN - 1", () => {
    expect(isVersionAcceptable(MIN_SUPPORTED_LINK_PROTOCOL - 1)).toBe(false);
  });

  it("rejects 0", () => {
    expect(isVersionAcceptable(0)).toBe(false);
  });

  it("exposes a user-actionable upgrade message", () => {
    expect(LINK_PROTOCOL_UPGRADE_MESSAGE).toContain(
      "Your desktop link is out of date.",
    );
    expect(LINK_PROTOCOL_UPGRADE_MESSAGE).toContain("bunx decocms@latest link");
  });
});

describe("link protocol v3 hard break", () => {
  it("pins version 3 and refuses v2 daemons", () => {
    expect(LINK_PROTOCOL_VERSION).toBe(3);
    expect(MIN_SUPPORTED_LINK_PROTOCOL).toBe(3);
    expect(isVersionAcceptable(1)).toBe(false);
    expect(isVersionAcceptable(2)).toBe(false);
    expect(isVersionAcceptable(3)).toBe(true);
  });
});
