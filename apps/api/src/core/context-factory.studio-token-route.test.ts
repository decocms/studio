/**
 * The only route an `x-studio-token` authenticates by itself (no
 * `Authorization` header): sites.decocms.com's access lookup.
 */
import { describe, expect, it } from "bun:test";
import { isStudioTokenOnlyRoute } from "./context-factory";

const req = (path: string, method = "GET") =>
  new Request(`https://studio.example.com${path}`, { method });

describe("isStudioTokenOnlyRoute", () => {
  it("matches GET /api/:org/sites/:site/access", () => {
    expect(isStudioTokenOnlyRoute(req("/api/acme/sites/store/access"))).toBe(
      true,
    );
  });

  it("refuses other methods on that path", () => {
    for (const method of ["POST", "PUT", "DELETE", "HEAD"]) {
      expect(
        isStudioTokenOnlyRoute(req("/api/acme/sites/store/access", method)),
      ).toBe(false);
    }
  });

  it("refuses every other path, including near misses", () => {
    for (const path of [
      "/api/acme/sites/store/access/",
      "/api/acme/sites/store/access/x",
      "/api/acme/sites/store",
      "/api/acme/sites//access",
      "/api/sites/store/access",
      "/api/acme/mcp/sites/store/access",
      "/api/cms/store/drafts",
      "/api/acme/tools",
    ]) {
      expect(isStudioTokenOnlyRoute(req(path)), path).toBe(false);
    }
  });
});
