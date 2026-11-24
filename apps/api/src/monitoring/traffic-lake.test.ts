import { describe, expect, it, mock } from "bun:test";

const newestByOrg = new Map<string, number | Error>();
const reads: string[] = [];

mock.module("../customer-lake/client", () => ({
  queryCustomerLake: async (organizationId: string) => {
    reads.push(organizationId);
    const v = newestByOrg.get(organizationId);
    if (v instanceof Error) throw v;
    return [{ newest: String(v ?? 0) }];
  },
}));

const { lakeHasPassed } = await import("./traffic-lake");

const hour = (iso: string) => Date.parse(iso) / 1000;
const judged = new Date("2026-11-19T18:00:00Z");

describe("lakeHasPassed", () => {
  it("waits while no org has traffic from after the judged hour", async () => {
    newestByOrg.set("a", hour("2026-11-19T18:00:00Z"));
    newestByOrg.set("b", 0);
    expect(
      await lakeHasPassed(["a", "b"], new Date("2026-11-19T19:16:00Z"), judged),
    ).toBe(false);
  });

  it("judges once any org's sites reached the next hour, even if one org went dark or fails", async () => {
    newestByOrg.set("a", hour("2026-11-19T19:00:00Z"));
    newestByOrg.set("b", 0);
    newestByOrg.set("c", new Error("ECONNRESET"));
    expect(
      await lakeHasPassed(
        ["a", "b", "c"],
        new Date("2026-11-19T19:21:00Z"),
        judged,
      ),
    ).toBe(true);
  });

  it("reads each org once per sweep", async () => {
    reads.length = 0;
    const at = new Date("2026-11-19T19:26:00Z");
    await Promise.all([
      lakeHasPassed(["a", "b"], at, judged),
      lakeHasPassed(["a", "b"], at, judged),
    ]);
    expect(reads).toEqual(["a", "b"]);
  });
});
