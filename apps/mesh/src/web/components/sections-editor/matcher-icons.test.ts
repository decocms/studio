import { describe, expect, it } from "bun:test";
import { resolveMatcherIconName } from "./matcher-icons";
import { resolveBlockSchemaMetadata } from "./resolve-schema";
import type { LiveMeta } from "./resolve-schema";

describe("matcher-icons", () => {
  it("resolveMatcherIconName maps known matchers and admin schema icons", () => {
    expect(resolveMatcherIconName("website/matchers/device.ts")).toBe(
      "Phone02",
    );
    expect(resolveMatcherIconName("website/matchers/date.ts")).toBe("Calendar");
    expect(
      resolveMatcherIconName("website/matchers/custom.ts", "device-mobile"),
    ).toBe("Phone02");
    expect(
      resolveMatcherIconName("website/matchers/custom.ts", "Calendar"),
    ).toBe("Calendar");
  });

  it("resolveBlockSchemaMetadata reads icon/title/description from live meta", () => {
    const meta: LiveMeta = {
      manifest: {
        blocks: {
          "website/matchers": {
            "website/matchers/device.ts": {
              $ref: "#/definitions/DeviceMatcher",
            },
          },
        },
      },
      schema: {
        definitions: {
          DeviceMatcher: {
            title: "By Device",
            description: "Target users by device type",
            icon: "device-mobile",
          },
        },
      },
    };

    expect(
      resolveBlockSchemaMetadata("website/matchers/device.ts", meta),
    ).toEqual({
      title: "By Device",
      description: "Target users by device type",
      icon: "device-mobile",
    });
  });
});
