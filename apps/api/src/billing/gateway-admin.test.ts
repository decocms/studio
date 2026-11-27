import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { getSettings, setGlobalSettings } from "../settings";
import {
  GatewayAdminPermanentError,
  requestGatewayInvoiceUpgrade,
  setGatewayOrgPlan,
} from "./gateway-admin";

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

/**
 * "Add to my invoice" must reach the gateway route that writes the record
 * finance bills from, and a refusal must come back as the gateway's sentence,
 * not a status dump the user cannot act on.
 */
describe("requestGatewayInvoiceUpgrade", () => {
  const original = getSettings();
  afterEach(() => setGlobalSettings(original));

  const configure = () =>
    setGlobalSettings({
      ...original,
      aiGatewayEnabled: true,
      aiGatewayUrl: "https://gateway.test",
      aiGatewayAdminToken: "test-token",
    });

  const request = () =>
    requestGatewayInvoiceUpgrade({
      organizationId: "org_1",
      planId: "business",
      requestedBy: "owner@example.com",
    });

  it("posts to the invoice-upgrade route and returns the record", async () => {
    configure();
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          replayed: false,
          upgrade: { id: "u_1", fromPlanId: "custom", toPlanId: "business" },
        }),
      ),
    );
    try {
      const result = await request();
      expect(result).toEqual({
        replayed: false,
        upgrade: { id: "u_1", fromPlanId: "custom" },
      });
      const [url, init] = fetchSpy.mock.calls[0] ?? [];
      expect(String(url)).toBe(
        "https://gateway.test/api/admin/plans/invoice-upgrade",
      );
      expect(JSON.parse(String(init?.body))).toEqual({
        orgId: "org_1",
        planId: "business",
        requestedBy: "owner@example.com",
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("surfaces the gateway's refusal as the reason", async () => {
    configure();
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          error: "This organization cannot add a plan to its invoice.",
        }),
        { status: 409 },
      ),
    );
    try {
      const err = await request().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GatewayAdminPermanentError);
      expect((err as GatewayAdminPermanentError).reason).toBe(
        "This organization cannot add a plan to its invoice.",
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("refuses without calling out when the admin token is missing", async () => {
    setGlobalSettings({
      ...original,
      aiGatewayEnabled: true,
      aiGatewayAdminToken: "",
    });
    await expect(request()).rejects.toThrow(/not configured/);
  });
});
