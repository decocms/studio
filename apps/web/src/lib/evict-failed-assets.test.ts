import { describe, expect, test } from "bun:test";
import { failedAssetUrls } from "./evict-failed-assets";

const ORIGIN = "https://studio.example.com";

describe("failedAssetUrls", () => {
  test("keeps same-origin /assets/ entries with an error status, deduped", () => {
    expect(
      failedAssetUrls(
        [
          { name: `${ORIGIN}/assets/runtime-abc.js`, responseStatus: 404 },
          { name: `${ORIGIN}/assets/runtime-abc.js`, responseStatus: 404 },
          { name: `${ORIGIN}/assets/layout-def.js`, responseStatus: 200 },
          { name: `${ORIGIN}/assets/style-ghi.css`, responseStatus: 500 },
        ],
        ORIGIN,
      ),
    ).toEqual([
      `${ORIGIN}/assets/runtime-abc.js`,
      `${ORIGIN}/assets/style-ghi.css`,
    ]);
  });

  test("ignores other origins, other paths, and missing statuses", () => {
    expect(
      failedAssetUrls(
        [
          { name: "https://cdn.example.com/assets/x.js", responseStatus: 404 },
          { name: `${ORIGIN}/api/org/x`, responseStatus: 404 },
          { name: `${ORIGIN}/assets/blocked.js`, responseStatus: 0 },
          { name: `${ORIGIN}/assets/safari.js` },
        ],
        ORIGIN,
      ),
    ).toEqual([]);
  });
});
