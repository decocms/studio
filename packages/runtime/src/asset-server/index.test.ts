import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import {
  isPathWithinDirectory,
  resolveAssetPathWithTraversalCheck,
  createAssetHandler,
} from "./index";
import { resolve } from "path";
import { mkdirSync, writeFileSync, rmSync } from "fs";

describe("isPathWithinDirectory", () => {
  const baseDir = "/app/client";

  describe("safe paths", () => {
    test("allows file directly in base directory", () => {
      expect(isPathWithinDirectory("/app/client/index.html", baseDir)).toBe(
        true,
      );
    });

    test("allows file in subdirectory", () => {
      expect(
        isPathWithinDirectory("/app/client/assets/style.css", baseDir),
      ).toBe(true);
    });

    test("allows deeply nested file", () => {
      expect(
        isPathWithinDirectory("/app/client/assets/images/logo.png", baseDir),
      ).toBe(true);
    });

    test("allows base directory itself", () => {
      expect(isPathWithinDirectory("/app/client", baseDir)).toBe(true);
    });

    test("allows file with spaces in name", () => {
      expect(
        isPathWithinDirectory("/app/client/logos/deco logo.svg", baseDir),
      ).toBe(true);
    });
  });

  describe("path traversal attacks - BLOCKED", () => {
    test("blocks simple traversal to parent", () => {
      expect(isPathWithinDirectory("/app/style.css", baseDir)).toBe(false);
    });

    test("blocks traversal to root", () => {
      expect(isPathWithinDirectory("/etc/passwd", baseDir)).toBe(false);
    });

    test("blocks traversal with ../ sequence", () => {
      const traversalPath = resolve(baseDir, "../../../etc/passwd");
      expect(isPathWithinDirectory(traversalPath, baseDir)).toBe(false);
    });

    test("blocks traversal to sibling directory", () => {
      expect(isPathWithinDirectory("/app/server/secrets.json", baseDir)).toBe(
        false,
      );
    });

    test("blocks path that starts with baseDir but is actually sibling", () => {
      // /app/client-secrets is NOT within /app/client
      expect(isPathWithinDirectory("/app/client-secrets/key", baseDir)).toBe(
        false,
      );
    });

    test("blocks absolute path outside base", () => {
      expect(isPathWithinDirectory("/var/log/system.log", baseDir)).toBe(false);
    });
  });
});

describe("resolveAssetPathWithTraversalCheck", () => {
  const clientDir = "/app/dist/client";

  // Helper to reduce boilerplate
  const resolvePath = (requestPath: string) =>
    resolveAssetPathWithTraversalCheck({ requestPath, clientDir });

  describe("valid paths", () => {
    test("resolves root to clientDir", () => {
      expect(resolvePath("/")).toBe(clientDir);
    });

    test("resolves CSS file", () => {
      expect(resolvePath("/style.css")).toBe("/app/dist/client/style.css");
    });

    test("resolves nested path", () => {
      expect(resolvePath("/assets/app.js")).toBe(
        "/app/dist/client/assets/app.js",
      );
    });

    test("resolves path without extension", () => {
      expect(resolvePath("/dashboard")).toBe("/app/dist/client/dashboard");
    });

    test("resolves path with dots (SPA route)", () => {
      expect(resolvePath("/user/john.doe")).toBe(
        "/app/dist/client/user/john.doe",
      );
    });

    test("resolves file with spaces", () => {
      expect(resolvePath("/logos/deco logo.svg")).toBe(
        "/app/dist/client/logos/deco logo.svg",
      );
    });
  });

  describe("path traversal attacks - BLOCKED", () => {
    test("blocks /../../../etc/passwd", () => {
      expect(resolvePath("/../../../etc/passwd")).toBeNull();
    });

    test("blocks /assets/../../../etc/passwd", () => {
      expect(resolvePath("/assets/../../../etc/passwd")).toBeNull();
    });

    test("blocks /./../../etc/passwd", () => {
      expect(resolvePath("/./../../etc/passwd")).toBeNull();
    });

    test("blocks /../etc/passwd", () => {
      expect(resolvePath("/../etc/passwd")).toBeNull();
    });

    test("allows backslash paths (treated as literal on Unix)", () => {
      // On Unix, backslashes are literal characters - path stays in clientDir
      expect(resolvePath("/..\\..\\etc\\passwd")).not.toBeNull();
    });

    test("blocks /assets/../../package.json", () => {
      expect(resolvePath("/assets/../../package.json")).toBeNull();
    });

    test("blocks //etc/passwd (resolves to absolute path)", () => {
      // Double slash after stripping leading / becomes /etc/passwd (absolute)
      expect(resolvePath("//etc/passwd")).toBeNull();
    });

    test("blocks /valid/../../../etc/passwd", () => {
      expect(resolvePath("/valid/../../../etc/passwd")).toBeNull();
    });
  });
});

describe("createAssetHandler", () => {
  // Temp directory for tests that need real files
  const tempDir = resolve(import.meta.dir, ".test-temp-client");
  const indexContent = "<!DOCTYPE html><html><body>SPA</body></html>";
  const cssContent = "body { color: red; }";

  const jsContent = "export default function(){}";
  const faviconContent = "<svg/>";

  beforeAll(() => {
    // Create temp directory with test files
    mkdirSync(resolve(tempDir, "assets"), { recursive: true });
    writeFileSync(resolve(tempDir, "index.html"), indexContent);
    writeFileSync(resolve(tempDir, "assets/style.css"), cssContent);
    writeFileSync(resolve(tempDir, "assets/chunk-AbC123.js"), jsContent);
    writeFileSync(resolve(tempDir, "favicon.svg"), faviconContent);
  });

  afterAll(() => {
    // Clean up temp directory
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("malformed URL encoding", () => {
    test("handles malformed percent-encoded sequences gracefully", async () => {
      // Create handler in production mode to test the decodeURIComponent path
      const handler = createAssetHandler({
        env: "production",
        clientDir: "/app/dist/client",
      });

      // %E0%A4%A is an incomplete UTF-8 sequence that causes decodeURIComponent to throw
      const malformedUrl = "http://localhost:3000/%E0%A4%A";
      const request = new Request(malformedUrl);

      // Should return null (graceful fallback) instead of throwing
      const result = await handler(request);
      expect(result).toBeNull();
    });

    test("handles %FF (invalid UTF-8 byte) gracefully", async () => {
      const handler = createAssetHandler({
        env: "production",
        clientDir: "/app/dist/client",
      });

      // %FF is not valid in UTF-8
      const malformedUrl = "http://localhost:3000/%FF";
      const request = new Request(malformedUrl);

      const result = await handler(request);
      expect(result).toBeNull();
    });

    test("handles truncated multi-byte sequence gracefully", async () => {
      const handler = createAssetHandler({
        env: "production",
        clientDir: "/app/dist/client",
      });

      // %C2 expects a continuation byte but is truncated
      const malformedUrl = "http://localhost:3000/file%C2.txt";
      const request = new Request(malformedUrl);

      const result = await handler(request);
      expect(result).toBeNull();
    });
  });

  describe("SPA fallback for routes with dots", () => {
    const acceptsHtml = {
      headers: {
        accept: "text/html",
      },
    };
    test("serves index.html for /user/john.doe (non-existent path with dot)", async () => {
      const handler = createAssetHandler({
        env: "production",
        clientDir: tempDir,
      });

      const request = new Request(
        "http://localhost:3000/user/john.doe",
        acceptsHtml,
      );
      const result = await handler(request);

      expect(result).not.toBeNull();
      expect(result?.status).toBe(200);
      const text = await result?.text();
      expect(text).toBe(indexContent);
    });

    test("serves index.html for /page/v2.0 (version-like route)", async () => {
      const handler = createAssetHandler({
        env: "production",
        clientDir: tempDir,
      });

      const request = new Request(
        "http://localhost:3000/page/v2.0",
        acceptsHtml,
      );
      const result = await handler(request);

      expect(result).not.toBeNull();
      const text = await result?.text();
      expect(text).toBe(indexContent);
    });

    test("serves index.html for /files/report.2024 (date-like route)", async () => {
      const handler = createAssetHandler({
        env: "production",
        clientDir: tempDir,
      });

      const request = new Request(
        "http://localhost:3000/files/report.2024",
        acceptsHtml,
      );
      const result = await handler(request);

      expect(result).not.toBeNull();
      const text = await result?.text();
      expect(text).toBe(indexContent);
    });

    test("serves actual file when it exists", async () => {
      const handler = createAssetHandler({
        env: "production",
        clientDir: tempDir,
      });

      const request = new Request(
        "http://localhost:3000/assets/style.css",
        acceptsHtml,
      );
      const result = await handler(request);

      expect(result).not.toBeNull();
      expect(result?.status).toBe(200);
      const text = await result?.text();
      expect(text).toBe(cssContent);
    });

    test("serves index.html for non-existent .css file", async () => {
      const handler = createAssetHandler({
        env: "production",
        clientDir: tempDir,
      });

      // This CSS file doesn't exist, so it should fall back to index.html
      const request = new Request(
        "http://localhost:3000/assets/nonexistent.css",
        acceptsHtml,
      );
      const result = await handler(request);

      expect(result).not.toBeNull();
      const text = await result?.text();
      expect(text).toBe(indexContent);
    });

    test("serves index.html for route without dots", async () => {
      const handler = createAssetHandler({
        env: "production",
        clientDir: tempDir,
      });

      const request = new Request(
        "http://localhost:3000/dashboard",
        acceptsHtml,
      );
      const result = await handler(request);

      expect(result).not.toBeNull();
      const text = await result?.text();
      expect(text).toBe(indexContent);
    });
  });

  describe("Cache-Control headers", () => {
    const acceptsHtml = { headers: { accept: "text/html" } };

    test("index.html returns Cache-Control: no-cache", async () => {
      const handler = createAssetHandler({
        env: "production",
        clientDir: tempDir,
      });

      const request = new Request("http://localhost:3000/", acceptsHtml);
      const result = await handler(request);

      expect(result).not.toBeNull();
      expect(result!.headers.get("Cache-Control")).toBe("no-cache");
    });

    test("SPA fallback returns Cache-Control: no-cache", async () => {
      const handler = createAssetHandler({
        env: "production",
        clientDir: tempDir,
      });

      const request = new Request(
        "http://localhost:3000/some/spa/route",
        acceptsHtml,
      );
      const result = await handler(request);

      expect(result).not.toBeNull();
      expect(result!.headers.get("Cache-Control")).toBe("no-cache");
    });

    test("hashed JS asset returns Cache-Control: immutable", async () => {
      const handler = createAssetHandler({
        env: "production",
        clientDir: tempDir,
      });

      const request = new Request(
        "http://localhost:3000/assets/chunk-AbC123.js",
      );
      const result = await handler(request);

      expect(result).not.toBeNull();
      expect(result!.headers.get("Cache-Control")).toBe(
        "public, max-age=31536000, immutable",
      );
    });

    test("CSS asset returns Cache-Control: immutable", async () => {
      const handler = createAssetHandler({
        env: "production",
        clientDir: tempDir,
      });

      const request = new Request("http://localhost:3000/assets/style.css");
      const result = await handler(request);

      expect(result).not.toBeNull();
      expect(result!.headers.get("Cache-Control")).toBe(
        "public, max-age=31536000, immutable",
      );
    });

    test("non-asset files return no Cache-Control header", async () => {
      const handler = createAssetHandler({
        env: "production",
        clientDir: tempDir,
      });

      const request = new Request("http://localhost:3000/favicon.svg");
      const result = await handler(request);

      expect(result).not.toBeNull();
      expect(result!.headers.get("Cache-Control")).toBeNull();
    });
  });
});
