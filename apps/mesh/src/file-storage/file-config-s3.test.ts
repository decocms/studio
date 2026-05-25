import { describe, expect, test } from "bun:test";
import { buildPublicUrl } from "./file-config-s3";
import type { FileConfigInfo } from "../storage/types";

function info(overrides: Partial<FileConfigInfo>): FileConfigInfo {
  return {
    id: "fcfg_test",
    organizationId: "org_test",
    name: "test",
    description: null,
    bucket: "my-bucket",
    region: "us-east-1",
    endpoint: null,
    forcePathStyle: false,
    prefix: null,
    publicUrlBase: null,
    createdBy: "u",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedBy: "u",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("buildPublicUrl", () => {
  test("publicUrlBase wins", () => {
    expect(
      buildPublicUrl(
        info({ publicUrlBase: "https://cdn.example.com" }),
        "foo/bar.png",
      ),
    ).toBe("https://cdn.example.com/foo/bar.png");
  });

  test("AWS virtual-host style by default", () => {
    expect(buildPublicUrl(info({}), "logo.png")).toBe(
      "https://my-bucket.s3.us-east-1.amazonaws.com/logo.png",
    );
  });

  test("AWS path-style when forcePathStyle is set", () => {
    expect(buildPublicUrl(info({ forcePathStyle: true }), "logo.png")).toBe(
      "https://s3.us-east-1.amazonaws.com/my-bucket/logo.png",
    );
  });

  test("custom endpoint falls back to path-style", () => {
    expect(
      buildPublicUrl(
        info({
          endpoint: "https://account.r2.cloudflarestorage.com",
          forcePathStyle: true,
        }),
        "x.png",
      ),
    ).toBe("https://account.r2.cloudflarestorage.com/my-bucket/x.png");
  });

  test("percent-encodes path segments but keeps slashes", () => {
    expect(buildPublicUrl(info({}), "folder/with spaces/é.png")).toBe(
      "https://my-bucket.s3.us-east-1.amazonaws.com/folder/with%20spaces/%C3%A9.png",
    );
  });
});
