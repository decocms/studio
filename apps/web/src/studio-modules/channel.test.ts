import { describe, expect, it } from "bun:test";
import { CHANNEL_MESSAGE, DEFAULT_STUDIO_ORIGIN } from "./channel";
import { STUDIO_MODULE_NAMES, studioModuleUrl } from "./messages";

/**
 * `channel.ts` is a byte-identical copy of `@decocms/blocks/protocol`'s
 * `src/protocol/channel.ts` (`cmp` them when the package changes it).
 */
describe("the Studio channel's contract with the page's bootstrap", () => {
  it("a page expects Studio's production origin unless its binding says otherwise", () => {
    expect(DEFAULT_STUDIO_ORIGIN).toBe("https://studio.decocms.com");
  });

  it("every module URL is on Studio's origin, as the page requires", () => {
    for (const name of STUDIO_MODULE_NAMES) {
      const url = new URL(
        studioModuleUrl(DEFAULT_STUDIO_ORIGIN, name, "1.0.0"),
      );
      expect(url.origin).toBe(DEFAULT_STUDIO_ORIGIN);
      expect(url.pathname).toBe(`/studio-modules/v1/${name}.js`);
    }
  });

  it("the channel's own messages are the reserved deco: ones", () => {
    for (const type of Object.values(CHANNEL_MESSAGE)) {
      expect(type.startsWith("deco:")).toBe(true);
    }
  });
});
