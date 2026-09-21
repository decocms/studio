import { describe, expect, it } from "bun:test";
import { manifestSiblingRepos } from "./manifest-repos";

const ref = { host: "github.com", path: "acme/shop.frontend" };
const walk = (graph: Record<string, string>) =>
  manifestSiblingRepos(async (repoPath) => graph[repoPath] ?? null, ref);
const deps = (...urls: string[]) =>
  `dependencies:\n${urls.map((u, i) => `  d${i}:\n    git:\n      url: ${u}\n`).join("")}`;

describe("manifestSiblingRepos", () => {
  it("walks the graph transitively, in both URL forms", async () => {
    expect(
      await walk({
        [ref.path]: deps(
          "https://github.com/acme/commons.git",
          "git@github.com:acme/checkout.git",
        ),
        "acme/commons": deps("https://github.com/acme/core.git"),
        "acme/core": deps("https://github.com/acme/webview.git"),
      }),
    ).toEqual(["commons", "checkout", "core", "webview"]);
  });

  it("skips another owner or host — no token here can reach them", async () => {
    expect(
      await walk({
        [ref.path]: deps(
          "https://github.com/othercorp/vendor.git",
          "https://gitlab.com/acme/commons.git",
        ),
      }),
    ).toEqual([]);
  });

  it("terminates on a cycle and never re-adds the root", async () => {
    expect(
      await walk({
        [ref.path]: deps("https://github.com/acme/a.git"),
        "acme/a": deps("https://github.com/acme/b.git"),
        "acme/b": deps(
          "https://github.com/acme/a.git",
          "https://github.com/acme/shop.frontend.git",
        ),
      }),
    ).toEqual(["a", "b"]);
  });

  it("caps the walk, and so the reads", async () => {
    let reads = 0;
    const repos = await manifestSiblingRepos(async (repoPath) => {
      reads++;
      const seed = repoPath.replace(/\W/g, "");
      return deps(`https://github.com/acme/${seed}1.git`);
    }, ref);
    expect(repos).toHaveLength(20);
    expect(reads).toBeLessThanOrEqual(21);
  });

  it("keeps walking past a read that fails or is missing", async () => {
    const repos = await manifestSiblingRepos(async (repoPath) => {
      if (repoPath === "acme/denied") throw new Error("403 outside the grant");
      if (repoPath === ref.path) {
        return deps(
          "https://github.com/acme/denied.git",
          "https://github.com/acme/ok.git",
        );
      }
      if (repoPath === "acme/ok")
        return deps("https://github.com/acme/deep.git");
      return null;
    }, ref);
    expect(repos).toEqual(["denied", "ok", "deep"]);
  });
});
