import { describe, expect, test } from "bun:test";
import {
  applySubsidizedBilling,
  RUN_BILLING_METADATA_KEY,
  SUBSCRIPTION_BILLING,
  taskRunMetadata,
} from "./subsidized-runs";

describe("taskRunMetadata", () => {
  test("stamps subscription billing ONLY on reports tasks", () => {
    expect(taskRunMetadata({ id: "t1", createdBy: "system" })).toEqual({
      taskBoardItemId: "t1",
      [RUN_BILLING_METADATA_KEY]: SUBSCRIPTION_BILLING,
    });
    expect(taskRunMetadata({ id: "t2", createdBy: "user_1" })).toEqual({
      taskBoardItemId: "t2",
    });
  });
});

describe("applySubsidizedBilling", () => {
  const source = {
    kind: "secret" as const,
    providerId: "deco",
    apiKey: "org-key",
    modelId: "anthropic/claude-sonnet-5",
  };
  const stamped = { [RUN_BILLING_METADATA_KEY]: SUBSCRIPTION_BILLING };

  test("swaps ONLY the payer on a stamped deco run", () => {
    const out = applySubsidizedBilling(source, stamped, "subsidy-key");
    expect(out).toEqual({ ...source, apiKey: "subsidy-key" });
  });

  test("no stamp / interactive run → untouched", () => {
    expect(applySubsidizedBilling(source, undefined, "subsidy-key")).toBe(
      source,
    );
    expect(
      applySubsidizedBilling(source, { taskBoardItemId: "t1" }, "subsidy-key"),
    ).toBe(source);
  });

  test("custom provider stays on the org's bill (their explicit choice)", () => {
    const custom = { ...source, providerId: "openai" };
    expect(applySubsidizedBilling(custom, stamped, "subsidy-key")).toBe(custom);
  });

  test("no subsidy key resolved → dormant (run stays on the org's key)", () => {
    expect(applySubsidizedBilling(source, stamped, undefined)).toBe(source);
  });
});
