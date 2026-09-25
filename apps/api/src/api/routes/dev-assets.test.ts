import { createHmac } from "node:crypto";
import { Hono } from "hono";
import { describe, expect, test } from "bun:test";
import { getSettings } from "../../settings";
import {
  createDevAssetsRoutes,
  getContentSecurityHeaders,
  getFilePath,
  verifySignature,
} from "./dev-assets";

function sign(
  orgId: string,
  key: string,
  expires: number,
  method: "GET" | "PUT",
): string {
  const secret = getSettings().encryptionKey || "dev-secret";
  return createHmac("sha256", secret)
    .update(`${orgId}:${key}:${expires}:${method}`)
    .digest("hex");
}

describe("verifySignature", () => {
  test("accepts a signature matching the expected HMAC", () => {
    const signature = sign("org_1", "logo.png", 9999999999, "GET");
    expect(
      verifySignature("org_1", "logo.png", 9999999999, "GET", signature),
    ).toBe(true);
  });

  test("rejects a same-length signature that doesn't match", () => {
    const signature = sign("org_1", "logo.png", 9999999999, "GET");
    const tampered = `${signature.slice(0, -1)}${signature.at(-1) === "0" ? "1" : "0"}`;
    expect(
      verifySignature("org_1", "logo.png", 9999999999, "GET", tampered),
    ).toBe(false);
  });

  test("rejects a mismatched-length signature without throwing", () => {
    expect(() =>
      verifySignature("org_1", "logo.png", 9999999999, "GET", "short"),
    ).not.toThrow();
    expect(
      verifySignature("org_1", "logo.png", 9999999999, "GET", "short"),
    ).toBe(false);
  });

  test("rejects a signature minted for a different method", () => {
    const signature = sign("org_1", "logo.png", 9999999999, "GET");
    expect(
      verifySignature("org_1", "logo.png", 9999999999, "PUT", signature),
    ).toBe(false);
  });
});

describe("getFilePath", () => {
  test("keeps a percent-encoded traversal key contained under the org dir", () => {
    const path = getFilePath("org_1", "%2e%2e/%2e%2e/etc/passwd");
    expect(path.startsWith("data/assets/org_1")).toBe(true);
    expect(path).not.toContain("..");
  });

  test("resolves a literal traversal key back under the org dir", () => {
    const path = getFilePath("org_1", "../../../etc/passwd");
    expect(path.startsWith("data/assets/org_1")).toBe(true);
  });
});

describe("getContentSecurityHeaders", () => {
  test("sandboxes an uploaded HTML file so it can't run with studio's origin", () => {
    const headers = getContentSecurityHeaders("text/html");
    expect(headers["Content-Security-Policy"]).toContain("sandbox");
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
  });

  test("sandboxes an uploaded SVG (script-capable) the same way", () => {
    const headers = getContentSecurityHeaders("image/svg+xml");
    expect(headers["Content-Security-Policy"]).toContain("sandbox");
  });

  test("skips CSP for a harmless type but still forbids sniffing", () => {
    const headers = getContentSecurityHeaders("image/png");
    expect(headers["Content-Security-Policy"]).toBeUndefined();
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
  });
});

describe("PUT /api/dev-assets/:orgId/*", () => {
  test("rejects a body over the per-file size limit before writing it", async () => {
    const app = new Hono().route(
      "/api/dev-assets",
      createDevAssetsRoutes({ orgFromPath: false }),
    );
    const expires = Math.floor(Date.now() / 1000) + 3600;
    const signature = sign("org_1", "big.bin", expires, "PUT");
    const oversized = new Uint8Array(500 * 1024 * 1024 + 1);

    const res = await app.request(
      `/api/dev-assets/org_1/big.bin?expires=${expires}&signature=${signature}&method=PUT`,
      {
        method: "PUT",
        body: oversized,
        headers: { "content-length": String(oversized.length) },
      },
    );

    expect(res.status).toBe(413);
  });
});
