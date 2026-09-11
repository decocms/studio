import { afterEach, describe, expect, it } from "bun:test";
import { getSettings, setGlobalSettings } from "../settings";
import { setGatewayOrgPlan } from "./gateway-admin";

/**
 * The Stripe webhook is the only path by which an org acquires a paid tier
 * (`AI_PLAN_SET` accepts nothing but `free`), and it places that tier through
 * this function. So "could not reach the gateway" has to be distinguishable
 * from "this deployment has no gateway": the first is a card charged for an
 * entitlement that never landed and must reach Stripe's retry queue, the
 * second is a self-hosted deployment with nothing to place.
 *
 * Both used to take the same silent `return`, which 200'd the webhook — so
 * Stripe never redelivered, nothing was logged, and the customer was billed
 * monthly for Free. The same return also swallowed CANCELLATIONS, leaving a
 * lapsed org on its paid tier indefinitely.
 */
describe("setGatewayOrgPlan when the gateway admin is not fully configured", () => {
  const original = getSettings();
  afterEach(() => setGlobalSettings(original));

  const place = () =>
    setGatewayOrgPlan({
      organizationId: "org_1",
      planId: "ultra",
      note: "stripe checkout cs_test",
    });

  it("no-ops when this deployment has no gateway at all", async () => {
    setGlobalSettings({
      ...original,
      aiGatewayEnabled: false,
      aiGatewayAdminToken: "",
    });
    expect(await place().then(() => "resolved")).toBe("resolved");
  });

  it("throws when there IS a gateway and the admin token is missing", async () => {
    setGlobalSettings({
      ...original,
      aiGatewayEnabled: true,
      aiGatewayAdminToken: "",
    });
    await expect(place()).rejects.toThrow(/DECO_AI_GATEWAY_ADMIN_TOKEN/);
  });
});
