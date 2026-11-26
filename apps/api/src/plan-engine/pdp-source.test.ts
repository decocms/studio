import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { __setPageWaitForTesting } from "./browser.ts";
import { fakeBrowser } from "./fixtures/fake-browser.ts";
import { isProductPageInPage, storeLinksInPage } from "./page-scripts.ts";
import { resolvePdpUrl } from "./pdp-source.ts";

let restoreWait: () => void;
beforeAll(() => {
  restoreWait = __setPageWaitForTesting(async () => {});
});
afterAll(() => restoreWait());

const ORIGIN = "https://loja-exemplo.com.br";

describe("resolvePdpUrl", () => {
  test("takes the first candidate that declares a product, without opening the home", async () => {
    let current = "";
    const f = fakeBrowser(() => ({
      goto: (url) => {
        current = url;
        return {};
      },
      scripts: new Map([
        [isProductPageInPage, () => current.includes("/vestido-b/")],
      ]),
    }));
    const url = await resolvePdpUrl(f.browser, "loja-exemplo.com.br", [
      `${ORIGIN}/vestido-a/p`,
      `${ORIGIN}/vestido-b/p`,
    ]);
    expect(url).toBe(`${ORIGIN}/vestido-b/p`);
    expect(f.visited).toEqual([
      `${ORIGIN}/vestido-a/p?html=1`,
      `${ORIGIN}/vestido-b/p?html=1`,
    ]);
  });

  test("with no candidate, takes the home's PDP links, still with ?html=1", async () => {
    let current = "";
    const f = fakeBrowser(() => ({
      goto: (url) => {
        current = url;
        return {};
      },
      scripts: new Map<unknown, (...args: unknown[]) => unknown>([
        [
          storeLinksInPage,
          () => ({
            origin: ORIGIN,
            links: [
              {
                href: `${ORIGIN}/saia-midi/p`,
                zone: "main",
                text: "",
                image: false,
              },
            ],
            text: "",
            heading: "",
          }),
        ],
        [isProductPageInPage, () => current.includes("/saia-midi/")],
      ]),
    }));
    const url = await resolvePdpUrl(f.browser, "loja-exemplo.com.br", []);
    expect(url).toBe(`${ORIGIN}/saia-midi/p`);
    for (const visited of f.visited) expect(visited).toContain("html=1");
  });
});
