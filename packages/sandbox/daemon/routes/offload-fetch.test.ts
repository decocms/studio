import { describe, expect, it } from "bun:test";
import { assertAllowedRefUrl } from "./offload-fetch";

const ALLOW = ["s3.amazonaws.com", "minio.local"];
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
