import { describe, expect, it } from "bun:test";

import { S3Store } from "./s3-store";

describe("S3Store", () => {
  it("prepends the configured prefix to keys", () => {
    const store = new S3Store({
      bucket: "test-bucket",
      prefix: "sandbox-snapshots",
    });
    expect(store.fullKey("org-a/vmcp-1/main.tar")).toBe(
      "sandbox-snapshots/org-a/vmcp-1/main.tar",
    );
  });

  it("strips trailing slashes from the prefix", () => {
    const store = new S3Store({
      bucket: "test-bucket",
      prefix: "sandbox-snapshots////",
    });
    expect(store.fullKey("x/y/z.tar")).toBe("sandbox-snapshots/x/y/z.tar");
  });

  it("omits the prefix when none is configured", () => {
    const store = new S3Store({ bucket: "test-bucket" });
    expect(store.fullKey("k.tar")).toBe("k.tar");
  });

  it("throws when bucket is missing", () => {
    expect(() => new S3Store({ bucket: "" })).toThrow(/bucket is required/);
  });
});
