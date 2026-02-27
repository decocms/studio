import { describe, expect, it, beforeEach } from "bun:test";
import { UIResourceLoader, UIResourceLoadError } from "./resource-loader.ts";

function createMockReadResource(
  response: { uri: string; text?: string; mimeType?: string }[] | null = null,
  shouldThrow = false,
) {
  return async (_uri: string) => {
    if (shouldThrow) throw new Error("Network error");
    return { contents: response ?? [] };
  };
}

describe("UIResourceLoadError", () => {
  it("creates error with uri and reason", () => {
    const err = new UIResourceLoadError("ui://test", "not found");
    expect(err.uri).toBe("ui://test");
    expect(err.reason).toBe("not found");
    expect(err.message).toContain("ui://test");
    expect(err.message).toContain("not found");
  });

  it("includes cause when provided", () => {
    const cause = new Error("original");
    const err = new UIResourceLoadError("ui://test", "failed", cause);
    expect(err.cause).toBe(cause);
  });
});

describe("UIResourceLoader", () => {
  let loader: UIResourceLoader;

  beforeEach(() => {
    loader = new UIResourceLoader({ cacheTTL: 0 });
  });

  it("loads and returns HTML content", async () => {
    const readResource = createMockReadResource([
      {
        uri: "ui://counter",
        text: "<html>counter</html>",
        mimeType: "text/html",
      },
    ]);
    const result = await loader.load("ui://counter", readResource);
    expect(result.html).toBe("<html>counter</html>");
    expect(result.uri).toBe("ui://counter");
  });

  it("throws when no content returned", async () => {
    const readResource = createMockReadResource([]);
    await expect(loader.load("ui://empty", readResource)).rejects.toThrow(
      UIResourceLoadError,
    );
  });

  it("throws when content has no text", async () => {
    const readResource = createMockReadResource([
      { uri: "ui://notext", mimeType: "text/html" },
    ]);
    await expect(loader.load("ui://notext", readResource)).rejects.toThrow(
      UIResourceLoadError,
    );
  });

  it("throws when resource fetch fails", async () => {
    const readResource = createMockReadResource(null, true);
    await expect(loader.load("ui://fail", readResource)).rejects.toThrow(
      UIResourceLoadError,
    );
  });

  it("loads different URIs separately", async () => {
    let callCount = 0;
    const readResource = async (uri: string) => {
      callCount++;
      return {
        contents: [{ uri, text: `<html>${uri}</html>`, mimeType: "text/html" }],
      };
    };
    const r1 = await loader.load("ui://a", readResource);
    const r2 = await loader.load("ui://b", readResource);
    expect(r1.html).toBe("<html>ui://a</html>");
    expect(r2.html).toBe("<html>ui://b</html>");
    expect(callCount).toBe(2);
  });
});

describe("UIResourceLoader caching", () => {
  it("caches resources when cacheTTL > 0", async () => {
    const loader = new UIResourceLoader({ cacheTTL: 60000 });
    let callCount = 0;
    const readResource = async (uri: string) => {
      callCount++;
      return {
        contents: [{ uri, text: "<html>cached</html>", mimeType: "text/html" }],
      };
    };
    await loader.load("ui://test", readResource);
    await loader.load("ui://test", readResource);
    expect(callCount).toBe(1);
  });

  it("clearCache clears all entries", async () => {
    const loader = new UIResourceLoader({ cacheTTL: 60000 });
    let callCount = 0;
    const readResource = async (uri: string) => {
      callCount++;
      return {
        contents: [{ uri, text: "<html>data</html>", mimeType: "text/html" }],
      };
    };
    await loader.load("ui://test", readResource);
    loader.clearCache();
    await loader.load("ui://test", readResource);
    expect(callCount).toBe(2);
  });

  it("does not cache when maxCacheSize is 0", async () => {
    const loader = new UIResourceLoader({
      cacheTTL: 60000,
      maxCacheSize: 0,
    });
    let callCount = 0;
    const readResource = async (uri: string) => {
      callCount++;
      return {
        contents: [{ uri, text: "<html>data</html>", mimeType: "text/html" }],
      };
    };
    await loader.load("ui://test", readResource);
    await loader.load("ui://test", readResource);
    expect(callCount).toBe(2);
  });
});
