import { describe, expect, test } from "bun:test";
import { appManifestPath, parseAppManifest } from "./manifest";

describe("parseAppManifest", () => {
  test("parses a valid manifest", () => {
    expect(
      parseAppManifest(
        JSON.stringify({
          kind: "eitri-app",
          publishedContent: true,
        }),
      ),
    ).toEqual({ kind: "eitri-app", publishedContent: true });
  });

  test("ignores unknown keys (an older manifest's previewLink)", () => {
    expect(
      parseAppManifest(
        JSON.stringify({
          kind: "eitri-app",
          publishedContent: true,
          previewLink: "https://www.example.com/deco-preview/{code}",
        }),
      ),
    ).toEqual({ kind: "eitri-app", publishedContent: true });
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
