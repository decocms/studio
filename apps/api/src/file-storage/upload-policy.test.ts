import { describe, expect, test } from "bun:test";
import {
  MAX_UPLOAD_BYTES,
  UploadRejected,
  assertAllowed,
  buildObjectKey,
  sanitizeFilename,
} from "./upload-policy";

describe("assertAllowed", () => {
  test("accepts allowed image types under the size cap", () => {
    expect(() => assertAllowed("image/png", 1024)).not.toThrow();
    expect(() => assertAllowed("image/webp", MAX_UPLOAD_BYTES)).not.toThrow();
  });

  test("rejects disallowed content types", () => {
    expect(() => assertAllowed("application/x-msdownload", 1024)).toThrow(
      UploadRejected,
    );
    expect(() => assertAllowed("text/html", 1024)).toThrow(UploadRejected);
  });

  test("rejects oversize uploads", () => {
    expect(() => assertAllowed("image/png", MAX_UPLOAD_BYTES + 1)).toThrow(
      UploadRejected,
    );
  });

  test("rejects non-positive sizes", () => {
    expect(() => assertAllowed("image/png", 0)).toThrow(UploadRejected);
    expect(() => assertAllowed("image/png", -5)).toThrow(UploadRejected);
  });
});

describe("sanitizeFilename", () => {
  test("lowercases and replaces unsafe chars", () => {
    expect(sanitizeFilename("Hello World!.PNG")).toBe("hello-world-.png");
  });

  test("ASCII-folds accented characters", () => {
    expect(sanitizeFilename("café résumé.jpg")).toBe("cafe-resume.jpg");
  });

  test("preserves extension when truncating", () => {
    const long = "a".repeat(120) + ".png";
    const result = sanitizeFilename(long);
    expect(result.length).toBeLessThanOrEqual(80);
    expect(result.endsWith(".png")).toBe(true);
  });

  test("never returns empty string", () => {
    expect(sanitizeFilename("???")).toBe("file");
  });
});

describe("buildObjectKey", () => {
  test("includes prefix, date shard, uuid, and filename", () => {
    const key = buildObjectKey({
      prefix: "tenants/acme/",
      filename: "logo.png",
    });
    expect(key.startsWith("tenants/acme/")).toBe(true);
    expect(key).toMatch(
      /^tenants\/acme\/\d{4}\/\d{2}\/[0-9a-f-]{36}-logo\.png$/,
    );
  });

  test("works without a prefix", () => {
    const key = buildObjectKey({ prefix: null, filename: "doc.pdf" });
    expect(key).toMatch(/^\d{4}\/\d{2}\/[0-9a-f-]{36}-doc\.pdf$/);
  });
});
