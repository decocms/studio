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
    expect(USER_ROLE_TOOLS.has("REPOSITORY_READ_FILE")).toBe(true);
    expect(
      resolveCapabilities({ self: [...USER_ROLE_TOOLS] })["changes:propose"],
    ).toBe(true);
  });

  it("lets the built-in user publish (merge a change request)", () => {
    expect(USER_ROLE_TOOLS.has("CHANGE_REQUEST_MERGE")).toBe(true);
    expect(
      resolveCapabilities({ self: [...USER_ROLE_TOOLS] })["changes:publish"],
    ).toBe(true);
  });

  it("keeps change requests out of basic usage", () => {
    expect(BASIC_USAGE_TOOLS.has("CHANGE_REQUEST_MERGE")).toBe(false);
    expect(BASIC_USAGE_TOOLS.has("CHANGE_REQUEST_OPEN")).toBe(false);
    expect(BASIC_USAGE_TOOLS.has("REPOSITORY_COMMIT_FILES")).toBe(false);
    expect(BASIC_USAGE_TOOLS.has("REPOSITORY_READ_FILE")).toBe(false);
  });
});

describe("channels permissions", () => {
  const reads = [
    "CHANNELS_CONNECTION_LIST",
    "CHANNELS_CONNECTION_GET",
    "CHANNELS_CONVERSATION_LIST",
    "CHANNELS_MESSAGE_LIST",
    "CHANNELS_MESSAGE_SEARCH",
  ];

  it("gives the built-in user channels:read, which a custom role can leave out", () => {
    for (const tool of reads) {
      expect(USER_ROLE_TOOLS.has(tool)).toBe(true);
      expect(BASIC_USAGE_TOOLS.has(tool)).toBe(false);
    }
    expect(
      resolveCapabilities({ self: [...USER_ROLE_TOOLS] })["channels:read"],
    ).toBe(true);
    expect(
      resolveCapabilities({ self: ["CHANNELS_CONNECTION_LIST"] })[
        "channels:read"
      ],
    ).toBe(false);
  });

  it("keeps channels:send out of the built-in user, apart from setup actions", () => {
    expect(USER_ROLE_TOOLS.has("CHANNELS_ACTION_SEND")).toBe(false);
    expect(BASIC_USAGE_TOOLS.has("CHANNELS_ACTION_SEND")).toBe(false);
    expect(USER_ROLE_TOOLS.has("CHANNELS_ACTION_CALL")).toBe(true);
    expect(USER_ROLE_TOOLS.has("CHANNELS_ACTION_LIST")).toBe(true);
    expect(
      resolveCapabilities({ self: [...USER_ROLE_TOOLS] })["channels:send"],
    ).toBe(false);
  });
});
