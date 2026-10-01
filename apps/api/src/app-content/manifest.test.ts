import { describe, expect, test } from "bun:test";
import type { RepoContentClient } from "@/git-providers";
import {
  appManifestPath,
  isAppPreviewServerUrl,
  parseAppManifest,
  readAppManifestCached,
} from "./manifest";

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

describe("vtexAccount", () => {
  test("is kept when it is an account name", () => {
    expect(
      parseAppManifest(
        JSON.stringify({ kind: "eitri-app", vtexAccount: "newbalance" }),
      ),
    ).toEqual({ kind: "eitri-app", vtexAccount: "newbalance" });
  });

  test("a host or anything else invalidates the manifest", () => {
    expect(
      parseAppManifest(
        JSON.stringify({ kind: "eitri-app", vtexAccount: "nb.myvtex.com" }),
      ),
    ).toBeNull();
  });
});

describe("readAppManifestCached", () => {
  const client = (text: string | null) => {
    const calls: string[] = [];
    const c = {
      repo: { host: "github.com", path: `acme/app-${Math.random()}` },
      readFileAtRef: async (ref: string, path: string) => {
        calls.push(`${ref}:${path}`);
        return text;
      },
    } as unknown as RepoContentClient;
    return { c, calls };
  };

  test("reads once per ref while fresh, concurrent callers included", async () => {
    const { c, calls } = client('{"kind":"eitri-app","vtexAccount":"nb"}');
    const [a, b] = await Promise.all([
      readAppManifestCached(c, "main", null),
      readAppManifestCached(c, "main", null),
    ]);
    await readAppManifestCached(c, "main", null);
    expect(a).toEqual({ kind: "eitri-app", vtexAccount: "nb" });
    expect(b).toEqual(a);
    expect(calls).toEqual(["main:.deco/app.json"]);
  });

  test("tells absent from invalid", async () => {
    expect(await readAppManifestCached(client(null).c, "main", null)).toBe(
      "absent",
    );
    expect(await readAppManifestCached(client("{}").c, "main", null)).toBe(
      "invalid",
    );
  });
});

describe("isAppPreviewServerUrl", () => {
  test.each([
    ["https://studio.test/api/acme/files/app-preview/vmcp_1/", true],
    ["https://nb.deco.site/", false],
    ["https://studio.test/api/acme/files/uploads/", false],
    ["https://studio.test/api/acme/files/app-preview/vmcp_1", false],
    ["not a url", false],
  ])("%s → %s", (url, expected) => {
    expect(isAppPreviewServerUrl(url)).toBe(expected);
  });
});
