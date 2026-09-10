import { describe, expect, it } from "bun:test";
import { modelDisclosureAllowed } from "./use-entitlements";

/**
 * The one gate that fails CLOSED. Every other entitlement gate fails open,
 * which is right for access and was wrong here: the model's name and its price
 * are withheld below Ultra, and "withheld" has to survive a pending query and
 * a failed one.
 */
describe("modelDisclosureAllowed", () => {
  // Also the sharp case: a FAILED read settles with no data, so an access gate
  // reads "no answer" and opens for the whole session. Same inputs here.
  it("withholds while the answer is in flight, and when it failed", () => {
    expect(
      modelDisclosureAllowed({
        plansEnabled: true,
        isSuccess: false,
        modelChoice: undefined,
      }),
    ).toBe(false);
  });

  it("discloses only on a real answer that includes the feature", () => {
    expect(
      modelDisclosureAllowed({
        plansEnabled: true,
        isSuccess: true,
        modelChoice: true,
      }),
    ).toBe(true);
    expect(
      modelDisclosureAllowed({
        plansEnabled: true,
        isSuccess: true,
        modelChoice: false,
      }),
    ).toBe(false);
  });

  it("withholds nothing when plans are off — exactly as before", () => {
    expect(
      modelDisclosureAllowed({
        plansEnabled: false,
        isSuccess: false,
        modelChoice: undefined,
      }),
    ).toBe(true);
  });
});
