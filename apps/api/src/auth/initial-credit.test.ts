import { describe, expect, it } from "bun:test";
import { stripPrivilegedMetadata } from "./initial-credit";

describe("stripPrivilegedMetadata", () => {
  it("removes initialCreditCents — the channel that let a user mint credit", () => {
    expect(stripPrivilegedMetadata({ initialCreditCents: 100_000 })).toBeUndefined();
  });

  it("removes it from the JSON-string form Better Auth may hand over", () => {
    expect(
      stripPrivilegedMetadata(JSON.stringify({ initialCreditCents: 2500 })),
    ).toBeUndefined();
  });

  it("keeps legitimate metadata while dropping the privileged key", () => {
    expect(
      stripPrivilegedMetadata({ description: "x", initialCreditCents: 500 }),
    ).toEqual({ description: "x" });
  });

  it("leaves metadata carrying no privileged key untouched", () => {
    expect(stripPrivilegedMetadata({ description: "x" })).toEqual({
      description: "x",
    });
  });

  it("strips a zero as well — any value at all is a value we did not authorize", () => {
    expect(stripPrivilegedMetadata({ initialCreditCents: 0 })).toBeUndefined();
  });

  it("returns undefined rather than an empty bag for non-object input", () => {
    for (const input of [undefined, null, "", "not json", 42, []]) {
      expect(stripPrivilegedMetadata(input)).toBeUndefined();
    }
  });
});
