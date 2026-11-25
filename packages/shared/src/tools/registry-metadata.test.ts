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

describe("default repository permissions", () => {
  it("lets users connect accounts and link repositories", () => {
    for (const tool of ["GIT_ACCOUNT_CONNECT_TOKEN", "REPOSITORY_LINK"]) {
      expect(USER_ROLE_TOOLS.has(tool)).toBe(true);
      expect(BASIC_USAGE_TOOLS.has(tool)).toBe(false);
    }
    expect(
      resolveCapabilities({ self: [...USER_ROLE_TOOLS] })[
        "repositories:connect"
      ],
    ).toBe(true);
  });
  it("does not grant account disconnection or repository deletion", () => {
    for (const tool of ["GIT_ACCOUNT_DELETE", "REPOSITORY_DELETE"]) {
      expect(USER_ROLE_TOOLS.has(tool)).toBe(false);
      expect(BASIC_USAGE_TOOLS.has(tool)).toBe(false);
    }
  });
});

describe("change request permissions", () => {
  it("lets the built-in user propose changes (write a branch, open a change request)", () => {
    expect(USER_ROLE_TOOLS.has("CHANGE_REQUEST_OPEN")).toBe(true);
    expect(USER_ROLE_TOOLS.has("REPOSITORY_COMMIT_FILES")).toBe(true);
    expect(
      resolveCapabilities({ self: [...USER_ROLE_TOOLS] })["changes:propose"],
    ).toBe(true);
  });

  it("keeps merging — what ships — out of the user and basic grants", () => {
    expect(USER_ROLE_TOOLS.has("CHANGE_REQUEST_MERGE")).toBe(false);
    expect(BASIC_USAGE_TOOLS.has("CHANGE_REQUEST_MERGE")).toBe(false);
    expect(BASIC_USAGE_TOOLS.has("CHANGE_REQUEST_OPEN")).toBe(false);
    expect(BASIC_USAGE_TOOLS.has("REPOSITORY_COMMIT_FILES")).toBe(false);
  });
});
