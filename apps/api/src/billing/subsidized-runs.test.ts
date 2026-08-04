import { describe, expect, test } from "bun:test";
import {
  applySubsidizedBilling,
  isSubscriptionBilledRun,
  RUN_BILLING_METADATA_KEY,
  sanitizeClientRunMetadata,
  SUBSCRIPTION_BILLING,
  subsidyGatewayOrgId,
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

describe("sanitizeClientRunMetadata", () => {
  test("strips the reserved server-owned namespace, keeps caller keys", () => {
    expect(
      sanitizeClientRunMetadata({
        // A webhook caller trying to award itself subsidized runs.
        [RUN_BILLING_METADATA_KEY]: SUBSCRIPTION_BILLING,
        "srv.anythingElse": "x",
        taskBoardItemId: "t1",
        myOwnKey: "keep me",
      }),
    ).toEqual({ taskBoardItemId: "t1", myOwnKey: "keep me" });
  });

  test("a sanitized bag can never read as subscription-billed", () => {
    const forged = { [RUN_BILLING_METADATA_KEY]: SUBSCRIPTION_BILLING };
    expect(isSubscriptionBilledRun(forged)).toBe(true); // pre-sanitize
    expect(isSubscriptionBilledRun(sanitizeClientRunMetadata(forged))).toBe(
      false,
    );
  });
});

describe("subsidyGatewayOrgId", () => {
  test("namespaces the org under the gateway's internal prefix", () => {
    expect(subsidyGatewayOrgId("org_1")).toBe("subsidy:org_1");
  });

  test("rejects ids that could escape the scheme", () => {
    expect(() => subsidyGatewayOrgId("subsidy:org_2")).toThrow(/unsuitable/);
    expect(() => subsidyGatewayOrgId("org 3")).toThrow(/unsuitable/);
  });
});

describe("applySubsidizedBilling", () => {
  const source = {
    kind: "secret" as const,
    providerId: "deco",
    apiKey: "org-key",
    modelId: "anthropic/claude-sonnet-5",
  };

  test("swaps ONLY the payer when a subsidy key was resolved", () => {
    expect(applySubsidizedBilling(source, "subsidy-key")).toEqual({
      ...source,
      apiKey: "subsidy-key",
    });
  });

  test("no subsidy key (not subsidized, or unresolvable) → untouched", () => {
    expect(applySubsidizedBilling(source, undefined)).toBe(source);
  });

  test("custom provider stays on the org's bill (their explicit choice)", () => {
    const custom = { ...source, providerId: "openai" };
    expect(applySubsidizedBilling(custom, "subsidy-key")).toBe(custom);
  });
});
