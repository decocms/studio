import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mapSubscriptionStatus, verifyStripeSignature } from "./stripe-webhook";

const SECRET = "whsec_test_secret";

function sign(body: string, secret = SECRET, t = 1_700_000_000): string {
  const v1 = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

describe("verifyStripeSignature", () => {
  test("accepts Stripe's v1 scheme over the raw body", async () => {
    const body = '{"type":"invoice.paid"}';
    expect(await verifyStripeSignature(body, sign(body), SECRET)).toBe(true);
  });

  test("rejects a tampered body, wrong secret, and malformed headers", async () => {
    const body = '{"type":"invoice.paid"}';
    const header = sign(body);
    expect(await verifyStripeSignature(`${body} `, header, SECRET)).toBe(false);
    expect(await verifyStripeSignature(body, sign(body, "other"), SECRET)).toBe(
      false,
    );
    expect(await verifyStripeSignature(body, "garbage", SECRET)).toBe(false);
    expect(await verifyStripeSignature(body, undefined, SECRET)).toBe(false);
    expect(await verifyStripeSignature(body, header, undefined)).toBe(false);
  });
});

describe("mapSubscriptionStatus", () => {
  test("active/trialing serve, past_due is grace, everything else is out", () => {
    expect(mapSubscriptionStatus("active")).toBe("active");
    expect(mapSubscriptionStatus("trialing")).toBe("active");
    expect(mapSubscriptionStatus("past_due")).toBe("past_due");
    expect(mapSubscriptionStatus("canceled")).toBe("canceled");
    expect(mapSubscriptionStatus("unpaid")).toBe("canceled");
    expect(mapSubscriptionStatus(undefined)).toBe("canceled");
  });
});
