import { describe, expect, it } from "bun:test";
import {
  isVersionAcceptable,
  LINK_PROTOCOL_VERSION,
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
});
