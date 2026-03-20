import { describe, expect, it } from "bun:test";
import {
  buildS3Key,
  buildS3Prefix,
  detectContentType,
  isTextContentType,
  sanitizeKey,
  stripOrgPrefix,
} from "./key-utils";

describe("sanitizeKey", () => {
  it("should pass through simple keys", () => {
    expect(sanitizeKey("documents/hello.txt")).toBe("documents/hello.txt");
  });

  it("should strip leading slash", () => {
    expect(sanitizeKey("/foo/bar")).toBe("foo/bar");
  });

  it("should strip trailing slash", () => {
    expect(sanitizeKey("foo/bar/")).toBe("foo/bar");
  });

  it("should collapse multiple slashes", () => {
    expect(sanitizeKey("foo///bar//baz")).toBe("foo/bar/baz");
  });

  it("should remove path traversal segments", () => {
    expect(sanitizeKey("../../../etc/passwd")).toBe("etc/passwd");
    expect(sanitizeKey("foo/../../bar")).toBe("bar");
    expect(sanitizeKey("foo/../bar")).toBe("bar");
  });

  it("should remove dot segments", () => {
    expect(sanitizeKey("./foo/./bar")).toBe("foo/bar");
  });

  it("should strip null bytes", () => {
    expect(sanitizeKey("foo\0bar")).toBe("foobar");
  });

  it("should strip control characters", () => {
    expect(sanitizeKey("foo\x01\x02bar\x7f")).toBe("foobar");
  });

  it("should normalize backslashes", () => {
    expect(sanitizeKey("foo\\bar\\baz")).toBe("foo/bar/baz");
  });

  it("should decode percent-encoded traversal before stripping", () => {
    expect(sanitizeKey("%2e%2e/%2e%2e/etc/passwd")).toBe("etc/passwd");
    expect(sanitizeKey("foo%2F..%2Fbar")).toBe("bar");
  });

  it("should decode percent-encoded null bytes before stripping", () => {
    expect(sanitizeKey("foo%00bar")).toBe("foobar");
  });

  it("should handle malformed percent encoding gracefully", () => {
    expect(sanitizeKey("foo%GGbar")).toBe("foo%GGbar");
  });

  it("should return empty string for traversal-only input", () => {
    expect(sanitizeKey("../..")).toBe("");
  });
});

describe("buildS3Key", () => {
  it("should prefix with org ID", () => {
    expect(buildS3Key("org_123", "documents/hello.txt")).toBe(
      "org_123/documents/hello.txt",
    );
  });

  it("should sanitize the key", () => {
    expect(buildS3Key("org_123", "../../../etc/passwd")).toBe(
      "org_123/etc/passwd",
    );
  });

  it("should throw on empty key after sanitization", () => {
    expect(() => buildS3Key("org_123", "../..")).toThrow(
      "Key is empty after sanitization",
    );
  });
});

describe("buildS3Prefix", () => {
  it("should return org prefix when no prefix given", () => {
    expect(buildS3Prefix("org_123")).toBe("org_123/");
  });

  it("should append sanitized prefix with trailing slash", () => {
    expect(buildS3Prefix("org_123", "documents")).toBe("org_123/documents/");
  });

  it("should not double trailing slash", () => {
    expect(buildS3Prefix("org_123", "documents/")).toBe("org_123/documents/");
  });

  it("should sanitize prefix for traversal", () => {
    expect(buildS3Prefix("org_123", "../../other-org")).toBe(
      "org_123/other-org/",
    );
  });
});

describe("stripOrgPrefix", () => {
  it("should strip the org prefix", () => {
    expect(stripOrgPrefix("org_123", "org_123/documents/hello.txt")).toBe(
      "documents/hello.txt",
    );
  });

  it("should return key unchanged if prefix doesn't match", () => {
    expect(stripOrgPrefix("org_123", "org_456/documents/hello.txt")).toBe(
      "org_456/documents/hello.txt",
    );
  });
});

describe("detectContentType", () => {
  it("should detect JSON", () => {
    expect(detectContentType("data.json")).toBe("application/json");
  });

  it("should detect HTML", () => {
    expect(detectContentType("index.html")).toBe("text/html");
  });

  it("should detect PNG", () => {
    expect(detectContentType("photo.png")).toBe("image/png");
  });

  it("should detect PDF", () => {
    expect(detectContentType("doc.pdf")).toBe("application/pdf");
  });

  it("should be case insensitive for extensions", () => {
    expect(detectContentType("file.JSON")).toBe("application/json");
    expect(detectContentType("file.PNG")).toBe("image/png");
  });

  it("should return octet-stream for unknown extensions", () => {
    expect(detectContentType("file.xyz")).toBe("application/octet-stream");
  });

  it("should return octet-stream for no extension", () => {
    expect(detectContentType("noext")).toBe("application/octet-stream");
  });
});

describe("isTextContentType", () => {
  it("should return true for known text types", () => {
    expect(isTextContentType("application/json")).toBe(true);
    expect(isTextContentType("text/plain")).toBe(true);
    expect(isTextContentType("text/html")).toBe(true);
    expect(isTextContentType("image/svg+xml")).toBe(true);
  });

  it("should return true for any text/* type", () => {
    expect(isTextContentType("text/x-custom")).toBe(true);
  });

  it("should handle content types with parameters", () => {
    expect(isTextContentType("application/json; charset=utf-8")).toBe(true);
    expect(isTextContentType("text/html; charset=iso-8859-1")).toBe(true);
    expect(isTextContentType("image/png; quality=80")).toBe(false);
  });

  it("should return false for binary types", () => {
    expect(isTextContentType("image/png")).toBe(false);
    expect(isTextContentType("application/pdf")).toBe(false);
    expect(isTextContentType("application/octet-stream")).toBe(false);
  });
});
