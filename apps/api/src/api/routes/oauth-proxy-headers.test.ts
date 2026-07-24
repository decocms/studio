import { describe, expect, test } from "bun:test";

/**
 * Tests for OAuth proxy header filtering logic.
 *
 * When proxying responses through Node.js fetch, the response body is
 * automatically decompressed, but headers like Content-Encoding and
 * Content-Length are preserved. We must filter these out to avoid
 * ERR_CONTENT_DECODING_FAILED errors.
 */
describe("OAuth Proxy Header Filtering", () => {
  const excludedHeaders = [
    "connection",
    "keep-alive",
    "transfer-encoding",
    "content-encoding",
    "content-length",
  ];

  const filterHeaders = (originalHeaders: Headers): Record<string, string> => {
    const filtered: Record<string, string> = {};
    for (const [key, value] of originalHeaders.entries()) {
      if (!excludedHeaders.includes(key.toLowerCase())) {
        filtered[key] = value;
      }
    }
    return filtered;
  };

  test("filters out Content-Encoding header", () => {
    const headers = new Headers({
      "Content-Type": "application/json",
      "Content-Encoding": "gzip",
    });

    const filtered = filterHeaders(headers);

    expect(filtered["content-type"]).toBe("application/json");
    expect(filtered["content-encoding"]).toBeUndefined();
  });

  test("filters out Content-Length header", () => {
    const headers = new Headers({
      "Content-Type": "application/json",
      "Content-Length": "1234",
    });

    const filtered = filterHeaders(headers);

    expect(filtered["content-type"]).toBe("application/json");
    expect(filtered["content-length"]).toBeUndefined();
  });

  test("filters out hop-by-hop headers", () => {
    const headers = new Headers({
      "Content-Type": "application/json",
      Connection: "keep-alive",
      "Keep-Alive": "timeout=5",
      "Transfer-Encoding": "chunked",
    });

    const filtered = filterHeaders(headers);

    expect(filtered["content-type"]).toBe("application/json");
    expect(filtered["connection"]).toBeUndefined();
    expect(filtered["keep-alive"]).toBeUndefined();
    expect(filtered["transfer-encoding"]).toBeUndefined();
  });

  test("preserves other headers", () => {
    const headers = new Headers({
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
      "X-Custom-Header": "custom-value",
      "Set-Cookie": "session=abc123",
    });

    const filtered = filterHeaders(headers);

    expect(filtered["content-type"]).toBe("application/json");
    expect(filtered["cache-control"]).toBe("no-cache");
    expect(filtered["x-custom-header"]).toBe("custom-value");
    expect(filtered["set-cookie"]).toBe("session=abc123");
  });

  test("handles case-insensitive header names", () => {
    const headers = new Headers();
    headers.set("CONTENT-ENCODING", "br");
    headers.set("CONTENT-LENGTH", "500");
    headers.set("CONTENT-TYPE", "text/html");

    const filtered = filterHeaders(headers);

    expect(filtered["content-encoding"]).toBeUndefined();
    expect(filtered["content-length"]).toBeUndefined();
    expect(filtered["content-type"]).toBe("text/html");
  });

  test("handles empty headers", () => {
    const headers = new Headers();
    const filtered = filterHeaders(headers);
    expect(Object.keys(filtered).length).toBe(0);
  });

  test("handles all common compression encodings", () => {
    // gzip
    let headers = new Headers({ "Content-Encoding": "gzip" });
    let filtered = filterHeaders(headers);
    expect(filtered["content-encoding"]).toBeUndefined();

    // br (brotli)
    headers = new Headers({ "Content-Encoding": "br" });
    filtered = filterHeaders(headers);
    expect(filtered["content-encoding"]).toBeUndefined();

    // deflate
    headers = new Headers({ "Content-Encoding": "deflate" });
    filtered = filterHeaders(headers);
    expect(filtered["content-encoding"]).toBeUndefined();
  });
});

describe("OAuth Proxy Response Construction", () => {
  test("response body is readable after header filtering", async () => {
    // Simulate what happens when proxying a response
    const originalBody = JSON.stringify({ access_token: "test_token" });
    const originalResponse = new Response(originalBody, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Content-Encoding": "gzip", // This would cause issues if not filtered
        "Content-Length": "50", // Wrong length if body was decompressed
      },
    });

    // Filter headers (simulating our proxy logic)
    const excludedHeaders = [
      "content-encoding",
      "content-length",
      "connection",
      "keep-alive",
      "transfer-encoding",
    ];
    const filteredHeaders = new Headers();
    for (const [key, value] of originalResponse.headers.entries()) {
      if (!excludedHeaders.includes(key.toLowerCase())) {
        filteredHeaders.set(key, value);
      }
    }

    // Create new response with filtered headers
    const proxyResponse = new Response(originalBody, {
      status: originalResponse.status,
      headers: filteredHeaders,
    });

    // Should be able to read body without errors
    const body = await proxyResponse.json();
    expect(body.access_token).toBe("test_token");

    // Should not have problematic headers
    expect(proxyResponse.headers.get("content-encoding")).toBeNull();
    expect(proxyResponse.headers.get("content-type")).toBe("application/json");
  });
});
