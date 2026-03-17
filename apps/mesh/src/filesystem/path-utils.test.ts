import { describe, expect, it } from "bun:test";
import {
  buildS3Key,
  buildS3Prefix,
  detectContentType,
  isTextContentType,
  sanitizePath,
  stripOrgPrefix,
} from "./path-utils";

describe("sanitizePath", () => {
  it("strips leading slashes", () => {
    expect(sanitizePath("/foo/bar")).toBe("foo/bar");
    expect(sanitizePath("///foo")).toBe("foo");
  });

  it("strips trailing slashes", () => {
    expect(sanitizePath("foo/bar/")).toBe("foo/bar");
  });

  it("removes .. segments", () => {
    expect(sanitizePath("../../../etc/passwd")).toBe("etc/passwd");
    expect(sanitizePath("foo/../bar")).toBe("foo/bar");
    expect(sanitizePath("foo/../../bar")).toBe("foo/bar");
  });

  it("removes . segments", () => {
    expect(sanitizePath("./foo/./bar")).toBe("foo/bar");
  });

  it("removes null bytes", () => {
    expect(sanitizePath("file\0.txt")).toBe("file.txt");
  });

  it("removes non-printable characters", () => {
    expect(sanitizePath("file\x01\x02.txt")).toBe("file.txt");
  });

  it("normalizes backslashes", () => {
    expect(sanitizePath("foo\\bar\\baz")).toBe("foo/bar/baz");
  });

  it("normalizes multiple slashes", () => {
    expect(sanitizePath("foo//bar///baz")).toBe("foo/bar/baz");
  });

  it("handles percent-encoded traversal", () => {
    expect(sanitizePath("%2e%2e%2ffoo")).toBe("foo");
  });

  it("strips percent-encoded null bytes", () => {
    expect(sanitizePath("file%00.txt")).toBe("file.txt");
  });

  it("handles malformed percent encoding gracefully", () => {
    expect(sanitizePath("file%ZZ.txt")).toBe("file%ZZ.txt");
  });

  it("handles empty string", () => {
    expect(sanitizePath("")).toBe("");
  });

  it("handles just dots", () => {
    expect(sanitizePath("..")).toBe("");
    expect(sanitizePath(".")).toBe("");
  });

  it("preserves normal paths", () => {
    expect(sanitizePath("docs/readme.md")).toBe("docs/readme.md");
    expect(sanitizePath("src/components/Button.tsx")).toBe(
      "src/components/Button.tsx",
    );
  });

  it("handles paths with spaces", () => {
    expect(sanitizePath("my folder/my file.txt")).toBe("my folder/my file.txt");
  });
});

describe("buildS3Key", () => {
  it("prefixes with org ID", () => {
    expect(buildS3Key("org_123", "docs/readme.md")).toBe(
      "org_123/docs/readme.md",
    );
  });

  it("sanitizes the path", () => {
    expect(buildS3Key("org_123", "../../../etc/passwd")).toBe(
      "org_123/etc/passwd",
    );
  });

  it("throws for empty path", () => {
    expect(() => buildS3Key("org_123", "")).toThrow("Path cannot be empty");
    expect(() => buildS3Key("org_123", "..")).toThrow("Path cannot be empty");
  });

  it("prevents escaping org prefix via traversal", () => {
    const key = buildS3Key("org_a", "../../org_b/secret.txt");
    expect(key).toBe("org_a/org_b/secret.txt");
    expect(key.startsWith("org_a/")).toBe(true);
  });
});

describe("buildS3Prefix", () => {
  it("returns org root when no path given", () => {
    expect(buildS3Prefix("org_123")).toBe("org_123/");
    expect(buildS3Prefix("org_123", undefined)).toBe("org_123/");
    expect(buildS3Prefix("org_123", "")).toBe("org_123/");
  });

  it("appends trailing slash to directory path", () => {
    expect(buildS3Prefix("org_123", "docs")).toBe("org_123/docs/");
  });

  it("preserves trailing slash", () => {
    expect(buildS3Prefix("org_123", "docs/")).toBe("org_123/docs/");
  });
});

describe("stripOrgPrefix", () => {
  it("strips the org prefix", () => {
    expect(stripOrgPrefix("org_123", "org_123/docs/readme.md")).toBe(
      "docs/readme.md",
    );
  });

  it("returns key unchanged if prefix doesn't match", () => {
    expect(stripOrgPrefix("org_123", "other/readme.md")).toBe(
      "other/readme.md",
    );
  });
});

describe("detectContentType", () => {
  it("detects text types", () => {
    expect(detectContentType("readme.md")).toBe("text/markdown");
    expect(detectContentType("style.css")).toBe("text/css");
    expect(detectContentType("index.html")).toBe("text/html");
  });

  it("detects code types", () => {
    expect(detectContentType("app.ts")).toBe("text/typescript");
    expect(detectContentType("config.json")).toBe("application/json");
    expect(detectContentType("script.js")).toBe("application/javascript");
  });

  it("detects image types", () => {
    expect(detectContentType("photo.png")).toBe("image/png");
    expect(detectContentType("photo.jpg")).toBe("image/jpeg");
  });

  it("defaults to octet-stream for unknown", () => {
    expect(detectContentType("file.xyz")).toBe("application/octet-stream");
    expect(detectContentType("noextension")).toBe("application/octet-stream");
  });
});

describe("isTextContentType", () => {
  it("returns true for text types", () => {
    expect(isTextContentType("text/plain")).toBe(true);
    expect(isTextContentType("text/markdown")).toBe(true);
    expect(isTextContentType("application/json")).toBe(true);
    expect(isTextContentType("application/javascript")).toBe(true);
    expect(isTextContentType("image/svg+xml")).toBe(true);
  });

  it("returns false for binary types", () => {
    expect(isTextContentType("image/png")).toBe(false);
    expect(isTextContentType("application/octet-stream")).toBe(false);
    expect(isTextContentType("application/pdf")).toBe(false);
  });
});
