import { describe, expect, test } from "bun:test";
import { BRAND_FILL_THREAD_KEY, brandFillOfThread } from "./brand-fill";

describe("brandFillOfThread", () => {
  test("a fill's chat names the brand it fills", () => {
    expect(
      brandFillOfThread({ [BRAND_FILL_THREAD_KEY]: { brand: "aurora" } }),
    ).toEqual({ brand: "aurora" });
  });

  test("any other chat is not a fill", () => {
    expect(brandFillOfThread(null)).toBeNull();
    expect(brandFillOfThread({})).toBeNull();
    expect(
      brandFillOfThread({ blogCard: { cardId: "abc", brand: "aurora" } }),
    ).toBeNull();
    expect(
      brandFillOfThread({ [BRAND_FILL_THREAD_KEY]: { brand: "" } }),
    ).toBeNull();
  });
});
