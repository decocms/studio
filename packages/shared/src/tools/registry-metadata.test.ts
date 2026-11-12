import { describe, expect, it } from "bun:test";
import {
  BASIC_USAGE_TOOLS,
  USER_ROLE_TOOLS,
  resolveCapabilities,
} from "./registry-metadata";

describe("CMS asset permissions", () => {
  it("lets members discover configured buckets and browse assets", () => {
    expect(BASIC_USAGE_TOOLS.has("FILE_CONFIG_LIST")).toBe(true);
    expect(BASIC_USAGE_TOOLS.has("FILE_OBJECTS_LIST")).toBe(true);
  });

  it("lets the built-in user upload and delete assets", () => {
    expect(USER_ROLE_TOOLS.has("FILE_OBJECT_UPLOAD")).toBe(true);
    expect(USER_ROLE_TOOLS.has("FILE_OBJECT_DELETE")).toBe(true);
    expect(
      resolveCapabilities({ self: [...USER_ROLE_TOOLS] })["assets:manage"],
    ).toBe(true);
  });

  it("keeps storage administration and asset writes out of basic usage", () => {
    for (const tool of ["FILE_OBJECT_UPLOAD", "FILE_OBJECT_DELETE"]) {
      expect(BASIC_USAGE_TOOLS.has(tool)).toBe(false);
    }
    for (const tool of [
      "FILE_CONFIG_CREATE",
      "FILE_CONFIG_UPDATE",
      "FILE_CONFIG_DELETE",
      "ORG_REPO_SYNC_CREATE",
      "ORG_REPO_SYNC_DELETE",
    ]) {
      expect(BASIC_USAGE_TOOLS.has(tool)).toBe(false);
      expect(USER_ROLE_TOOLS.has(tool)).toBe(false);
    }
  });
});
