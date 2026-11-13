import { describe, expect, it } from "bun:test";
import {
  CHANNEL_MESSAGE,
  DEFAULT_STUDIO_ORIGIN,
  DEFAULT_STUDIO_ORIGINS,
} from "./channel";
import { STUDIO_MODULE_NAMES, studioModuleUrl } from "./messages";

/**
 * `channel.ts` is a byte-identical copy of `@decocms/blocks/protocol`'s
 * `src/protocol/channel.ts` (`cmp` them when the package changes it).
 */
describe("the Studio channel's contract with the page's bootstrap", () => {
  it("a page trusts Studio's production and staging origins unless its binding says otherwise", () => {
    expect([...DEFAULT_STUDIO_ORIGINS]).toEqual([
      "https://studio.decocms.com",
      "https://studio-stg.decocms.com",
    ]);
    expect(DEFAULT_STUDIO_ORIGINS).toContain(DEFAULT_STUDIO_ORIGIN);
  });

  it("every module URL is on the origin of the Studio that sends it, as the page requires", () => {
    // The page accepts a deco:load only for a URL on the message's origin:
    // Studio's own (`location.origin`), whichever trusted Studio it is.
    for (const origin of DEFAULT_STUDIO_ORIGINS) {
      for (const name of STUDIO_MODULE_NAMES) {
        const url = new URL(studioModuleUrl(origin, name, "1.0.0"));
        expect(url.origin).toBe(origin);
        expect(url.pathname).toBe(`/studio-modules/v1/${name}.js`);
      }
    }
  });

  it("the channel's own messages are the reserved deco: ones", () => {
    for (const type of Object.values(CHANNEL_MESSAGE)) {
      expect(type.startsWith("deco:")).toBe(true);
    }
  });
});
