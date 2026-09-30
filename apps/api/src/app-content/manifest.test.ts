import { describe, expect, test } from "bun:test";
import {
  appManifestPath,
  isSafePreviewLink,
  parseAppManifest,
} from "./manifest";

describe("isSafePreviewLink", () => {
  test.each([
    "https://www.example.com/deco-preview/{code}",
    "exampleapp://deco-preview/{code}",
    "my.app+x-1://p?c={code}",
  ])("accepts %s", (link) => {
    expect(isSafePreviewLink(link)).toBe(true);
  });

  test.each([
    ["no code slot", "https://www.example.com/deco-preview"],
    ["http", "http://www.example.com/{code}"],
    ["javascript", "javascript:alert(1)//{code}"],
    ["data", "data:text/html,{code}"],
    ["file", "file:///etc/{code}"],
    ["blob", "blob:https://x/{code}"],
    ["vbscript", "vbscript:{code}"],
    ["about", "about:blank#{code}"],
    ["uppercase scheme", "JavaScript:alert(1)//{code}"],
    ["no scheme", "//www.example.com/{code}"],
    ["https without host", "https:///{code}"],
    ["https code in host", "https://{code}.example.com/"],
    ["https userinfo", "https://example.com@evil.test/{code}"],
    ["whitespace", "https://x.com/ {code}"],
    ["control char", "https://x.com/\u0000{code}"],
    ["too long", `https://x.com/${"a".repeat(512)}{code}`],
  ])("rejects %s", (_label, link) => {
    expect(isSafePreviewLink(link)).toBe(false);
  });
});

describe("parseAppManifest", () => {
  test("parses a valid manifest", () => {
    expect(
      parseAppManifest(
        JSON.stringify({
          kind: "eitri-app",
          publishedContent: true,
          previewLink: "https://www.example.com/deco-preview/{code}",
        }),
      ),
    ).toEqual({
      kind: "eitri-app",
      publishedContent: true,
      previewLink: "https://www.example.com/deco-preview/{code}",
    });
  });

  test("treats anything invalid as absent", () => {
    expect(parseAppManifest(null)).toBeNull();
    expect(parseAppManifest("not json")).toBeNull();
    expect(parseAppManifest("[]")).toBeNull();
    expect(parseAppManifest(JSON.stringify({ kind: "site" }))).toBeNull();
    expect(
      parseAppManifest(
        JSON.stringify({ kind: "eitri-app", publishedContent: "yes" }),
      ),
    ).toBeNull();
    // A bad link voids the whole manifest, including publishedContent.
    expect(
      parseAppManifest(
        JSON.stringify({
          kind: "eitri-app",
          publishedContent: true,
          previewLink: "javascript:{code}",
        }),
      ),
    ).toBeNull();
    expect(
      parseAppManifest(
        JSON.stringify({ kind: "eitri-app", pad: "x".repeat(70_000) }),
      ),
    ).toBeNull();
  });

  test("resolves the manifest path inside the runtime package", () => {
    expect(appManifestPath(null)).toBe(".deco/app.json");
    expect(appManifestPath("apps/shop")).toBe("apps/shop/.deco/app.json");
  });
});
