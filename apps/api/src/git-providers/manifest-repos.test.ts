import { describe, expect, it } from "bun:test";
import { manifestSiblingRepos, pubspecSiblingRepos } from "./manifest-repos";

const ref = { host: "github.com", path: "acme/app.flutter.shop.frontend" };

const PUBSPEC = `name: shop_app
dependencies:
  flutter:
    sdk: flutter
  acme_commons:
    git:
      url: https://github.com/acme/app.flutterlib.commons.frontend.git
      ref: v1.4.3
  acme_dito:
    git:
      url: https://github.com/acme/app.flutterlib.commons.frontend.git
      ref: v1.4.3
      path: packages/acme_dito
  acme_checkout:
    git:
      url: git@github.com:acme/app.flutterlib.checkout.frontend.git
      ref: v1.3.3
  diacritic: ^0.1.6
`;

describe("pubspecSiblingRepos", () => {
  it("collects same-owner git dependencies, deduped across both URL forms", () => {
    expect(pubspecSiblingRepos(PUBSPEC, ref)).toEqual([
      "app.flutterlib.commons.frontend",
      "app.flutterlib.checkout.frontend",
    ]);
  });

  it("drops a dependency under another owner — no token here can reach it", () => {
    const other = `dependencies:
  vendor_lib:
    git:
      url: https://github.com/othercorp/vendor-flutter-lib.git
`;
    expect(pubspecSiblingRepos(other, ref)).toEqual([]);
  });

  it("drops a dependency on another host", () => {
    const other = `dependencies:
  mirror:
    git:
      url: https://gitlab.com/acme/app.flutterlib.commons.frontend.git
`;
    expect(pubspecSiblingRepos(other, ref)).toEqual([]);
  });

  it("never spends a slot on the repository itself", () => {
    const selfref = `repository: https://github.com/acme/app.flutter.shop.frontend
dependencies:
  sibling:
    git:
      url: https://github.com/acme/app.flutterlib.commons.frontend.git
`;
    expect(pubspecSiblingRepos(selfref, ref)).toEqual([
      "app.flutterlib.commons.frontend",
    ]);
  });

  it("ignores userinfo already present in a URL", () => {
    const withToken = `dependencies:
  lib:
    git:
      url: https://x-access-token:redacted@github.com/acme/app.flutterlib.core.frontend.git
`;
    expect(pubspecSiblingRepos(withToken, ref)).toEqual([
      "app.flutterlib.core.frontend",
    ]);
  });

  it("caps how many siblings can widen one token", () => {
    const many = Array.from(
      { length: 40 },
      (_, i) =>
        `  l${i}:\n    git:\n      url: https://github.com/acme/lib-${i}.git`,
    ).join("\n");
    expect(pubspecSiblingRepos(`dependencies:\n${many}`, ref)).toHaveLength(20);
  });

  it("finds nothing in a manifest with no git dependencies", () => {
    expect(
      pubspecSiblingRepos("name: x\ndependencies:\n  http: ^1.0.0\n", ref),
    ).toEqual([]);
  });
});

describe("manifestSiblingRepos", () => {
  it("reads pubspec.yaml, starting at the repository itself", async () => {
    const reads: string[][] = [];
    const repos = await manifestSiblingRepos(async (repoPath, path) => {
      reads.push([repoPath, path]);
      return repoPath === ref.path ? PUBSPEC : null;
    }, ref);
    expect(reads[0]).toEqual([ref.path, "pubspec.yaml"]);
    expect(repos).toEqual([
      "app.flutterlib.commons.frontend",
      "app.flutterlib.checkout.frontend",
    ]);
  });

  it("walks transitively — pub get resolves the whole graph, so the token must too", async () => {
    const graph: Record<string, string> = {
      "acme/app.flutter.shop.frontend": `dependencies:
  commons:
    git:
      url: https://github.com/acme/app.flutterlib.commons.frontend.git
`,
      "acme/app.flutterlib.commons.frontend": `dependencies:
  core:
    git:
      url: https://github.com/acme/app.flutterlib.core.frontend.git
  ui:
    git:
      url: https://github.com/acme/app.flutterlib.ui.frontend.git
`,
      "acme/app.flutterlib.core.frontend": `dependencies:
  webview:
    git:
      url: https://github.com/acme/app.flutterlib.webview.frontend.git
`,
    };
    const repos = await manifestSiblingRepos(
      async (repoPath) => graph[repoPath] ?? null,
      ref,
    );
    expect(repos).toEqual([
      "app.flutterlib.commons.frontend",
      "app.flutterlib.core.frontend",
      "app.flutterlib.ui.frontend",
      "app.flutterlib.webview.frontend",
    ]);
  });

  it("terminates on a dependency cycle", async () => {
    const graph: Record<string, string> = {
      "acme/app.flutter.shop.frontend":
        "dependencies:\n  a:\n    git:\n      url: https://github.com/acme/lib-a.git\n",
      "acme/lib-a":
        "dependencies:\n  b:\n    git:\n      url: https://github.com/acme/lib-b.git\n",
      "acme/lib-b":
        "dependencies:\n  a:\n    git:\n      url: https://github.com/acme/lib-a.git\n",
    };
    const repos = await manifestSiblingRepos(
      async (repoPath) => graph[repoPath] ?? null,
      ref,
    );
    expect(repos).toEqual(["lib-a", "lib-b"]);
  });

  it("caps the walk, and so the reads, on a runaway graph", async () => {
    let reads = 0;
    const repos = await manifestSiblingRepos(async (repoPath) => {
      reads++;
      // Every repository names two more, forever.
      const seed = repoPath.replace(/\W/g, "");
      return `dependencies:
  x:
    git:
      url: https://github.com/acme/lib-${seed}-1.git
  y:
    git:
      url: https://github.com/acme/lib-${seed}-2.git
`;
    }, ref);
    expect(repos).toHaveLength(20);
    expect(reads).toBeLessThanOrEqual(21);
  });

  it("is no siblings, not an error, when the repo has no manifest", async () => {
    expect(await manifestSiblingRepos(async () => null, ref)).toEqual([]);
  });

  it("keeps walking when one repository's read fails — a grant may not cover it", async () => {
    const graph: Record<string, string> = {
      "acme/app.flutter.shop.frontend": `dependencies:
  denied:
    git:
      url: https://github.com/acme/app.flutterlib.denied.frontend.git
  ok:
    git:
      url: https://github.com/acme/app.flutterlib.ok.frontend.git
`,
      "acme/app.flutterlib.ok.frontend": `dependencies:
  deeper:
    git:
      url: https://github.com/acme/app.flutterlib.deeper.frontend.git
`,
    };
    const repos = await manifestSiblingRepos(async (repoPath) => {
      if (repoPath === "acme/app.flutterlib.denied.frontend") {
        throw new Error("403 outside what this account authorized");
      }
      return graph[repoPath] ?? null;
    }, ref);
    expect(repos).toEqual([
      "app.flutterlib.denied.frontend",
      "app.flutterlib.ok.frontend",
      "app.flutterlib.deeper.frontend",
    ]);
  });
});
