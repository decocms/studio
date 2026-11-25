import { describe, expect, test } from "bun:test";
import { defaultPreviewDeviceSize } from "./device-hint";

describe("defaultPreviewDeviceSize", () => {
  test("a mobile app's canvas opens on mobile; any other on desktop", () => {
    expect(defaultPreviewDeviceSize(true)).toBe("mobile");
    expect(defaultPreviewDeviceSize(false)).toBe("desktop");
  });
});
