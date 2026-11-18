import { describe, expect, test } from "bun:test";
import { ALERT_RULE_UPDATE } from "./rules";

describe("ALERT_RULE_UPDATE input", () => {
  const parse = (input: object) =>
    ALERT_RULE_UPDATE.inputSchema.safeParse(input).success;

  test("takes orders_drop's threshold as a percentage", () => {
    expect(parse({ rule: "orders_drop", threshold: 30, minVolume: 20 })).toBe(
      true,
    );
    expect(parse({ rule: "orders_drop", threshold: 0.5, minVolume: 20 })).toBe(
      false,
    );
    expect(parse({ rule: "orders_drop", threshold: 100, minVolume: 20 })).toBe(
      false,
    );
  });

  test("takes a spike's threshold as a multiple above 1", () => {
    expect(parse({ rule: "cancel_spike", threshold: 2.5, minVolume: 10 })).toBe(
      true,
    );
    expect(parse({ rule: "denied_spike", threshold: 1, minVolume: 10 })).toBe(
      false,
    );
  });

  test("rejects a negative minimum and an unknown rule", () => {
    expect(parse({ rule: "cancel_spike", threshold: 3, minVolume: -1 })).toBe(
      false,
    );
    expect(parse({ rule: "visitors_drop", threshold: 3, minVolume: 1 })).toBe(
      false,
    );
  });
});
