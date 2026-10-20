import { describe, expect, it } from "bun:test";
import { getSettings } from ".";

/**
 * A canary for a leaked `mock.module("…/settings")`.
 *
 * Bun runs every unit file in one process and keeps module mocks alive for the
 * whole shard, so a file that replaces this module and does not put it back
 * hands every later file a stub. That already happened: the stub exported only
 * `getSettings: () => ({ nodeEnv: "test" })`, so any code reading a flag saw
 * `undefined` — and `undefined` at the plan feature gate means "no answer",
 * which OPENS the gate. A test written for those gates would then pass whether
 * or not the gate worked, which is worse than having no test.
 *
 * This asserts nothing about any particular value; only that the module
 * answering is the real one, with a fully resolved shape.
 */
describe("the settings module is the real one, not a leaked mock", () => {
  it("answers with a fully resolved Settings object", () => {
    const settings = getSettings();
    // The two flags the plan feature gate reads before it consults the gateway.
    expect(typeof settings.plansEnabled).toBe("boolean");
    expect(typeof settings.aiGatewayEnabled).toBe("boolean");
    // A couple more, so this fails on a partial stub too.
    expect(typeof settings.nodeEnv).toBe("string");
    expect(typeof settings.port).toBe("number");
  });
});
