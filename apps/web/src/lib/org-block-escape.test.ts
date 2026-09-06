import { describe, expect, it } from "bun:test";
import { isBillingEscapeHatch } from "./org-block-escape";

describe("isBillingEscapeHatch", () => {
  it("matches the billing page a blocked org may still open", () => {
    expect(isBillingEscapeHatch("/acme/settings/infra-billing")).toBe(true);
    expect(isBillingEscapeHatch("/acme/settings/infra-billing/")).toBe(true);
  });

  it("does not match the rest of the billing settings group", () => {
    expect(isBillingEscapeHatch("/acme/settings/ai-providers")).toBe(false);
    expect(isBillingEscapeHatch("/acme/settings/members")).toBe(false);
  });

  it("does not match a route that merely mentions billing", () => {
    expect(isBillingEscapeHatch("/acme/settings/infra-billing/invoices")).toBe(
      false,
    );
    expect(isBillingEscapeHatch("/acme/infra-billing")).toBe(false);
  });
});
