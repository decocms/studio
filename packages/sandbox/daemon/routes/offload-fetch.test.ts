import { describe, expect, it } from "bun:test";
import { sha256Hex } from "../../../../apps/mesh/src/harnesses/offload-messages";
import { assertAllowedRefUrl } from "./offload-fetch";

const ALLOW = ["s3.amazonaws.com", "minio.local"];

describe("sha256Hex", () => {
  it("produces the correct hex digest for known bytes", async () => {
    // echo -n "" | sha256sum → e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
    const emptyDigest = await sha256Hex(new Uint8Array(0));
    expect(emptyDigest).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("produces different digests for different inputs", async () => {
    const a = await sha256Hex(new TextEncoder().encode("hello"));
    const b = await sha256Hex(new TextEncoder().encode("world"));
    expect(a).not.toBe(b);
  });
});

describe("assertAllowedRefUrl", () => {
  it("allows an https host on the allowlist", () => {
    expect(() =>
      assertAllowedRefUrl("https://s3.amazonaws.com/b/k", ALLOW, false),
    ).not.toThrow();
  });
  it("rejects an off-allowlist host", () => {
    expect(() =>
      assertAllowedRefUrl("https://evil.com/k", ALLOW, false),
    ).toThrow(/host not allowed/i);
  });
  it("rejects data: and non-https", () => {
    expect(() => assertAllowedRefUrl("data:x", ALLOW, false)).toThrow();
    expect(() =>
      assertAllowedRefUrl("http://s3.amazonaws.com/k", ALLOW, false),
    ).toThrow(/https/i);
  });
  it("allows http loopback only when same-host dev is enabled", () => {
    expect(() =>
      assertAllowedRefUrl("http://127.0.0.1:9000/k", ["127.0.0.1"], true),
    ).not.toThrow();
    expect(() =>
      assertAllowedRefUrl("http://127.0.0.1:9000/k", ["127.0.0.1"], false),
    ).toThrow();
  });
});
