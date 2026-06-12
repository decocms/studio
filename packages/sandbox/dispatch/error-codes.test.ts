import { describe, it, expect } from "bun:test";
import { LINK_ERROR_CODES } from "./error-codes";

describe("LINK_ERROR_CODES", () => {
  it("contains the known terminal codes", () => {
    expect(LINK_ERROR_CODES).toContain("ws_closed");
    expect(LINK_ERROR_CODES).toContain("offload_fetch_failed");
  });
});
