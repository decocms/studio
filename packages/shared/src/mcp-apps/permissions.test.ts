import { describe, expect, it } from "bun:test";
import { permissionsToAllow } from "./permissions.ts";

describe("permissionsToAllow", () => {
  it("maps declared permissions to Permission Policy features", () => {
    expect(permissionsToAllow({ microphone: {} })).toBe("microphone");
    expect(
      permissionsToAllow({ camera: {}, microphone: {}, clipboardWrite: {} }),
    ).toBe("camera; microphone; clipboard-write");
  });

  it("grants nothing when nothing is declared", () => {
    expect(permissionsToAllow(undefined)).toBe("");
    expect(permissionsToAllow(null)).toBe("");
    expect(permissionsToAllow({})).toBe("");
    expect(permissionsToAllow("microphone")).toBe("");
  });

  it("ignores unknown features instead of passing them through", () => {
    expect(
      permissionsToAllow({ microphone: {}, "usb *; payment": {}, display: {} }),
    ).toBe("microphone");
  });
});
