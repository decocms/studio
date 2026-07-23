import { describe, expect, test } from "bun:test";

async function readRepoFile(path: string): Promise<string> {
  return await Bun.file(new URL(`../${path}`, import.meta.url)).text();
}

describe("tunnel-only link transport", () => {
  test("link daemon does not retain the pull-transport fallback", async () => {
    const source = await readRepoFile("link-daemon/index.ts");

    expect(source).not.toContain("connectToClusterPull");
    expect(source).not.toContain("falling back to pull");
  });

  test("app wiring does not mount long-poll link routes", async () => {
    const source = await readRepoFile("api/app.ts");

    expect(source).not.toContain("createLinkWorkRoutes");
    expect(source).not.toContain("createLinkControlRoutes");
    expect(source).not.toContain("createLinkProxyRoutes");
    expect(source).not.toContain("LinkWorkQueue");
  });
});
