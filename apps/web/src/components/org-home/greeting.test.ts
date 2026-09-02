import { describe, expect, it } from "bun:test";
import { firstName, greetingSlot } from "./greeting";

describe("greetingSlot", () => {
  it("splits the day at noon and 18:00", () => {
    expect(greetingSlot(0)).toBe("morning");
    expect(greetingSlot(11)).toBe("morning");
    expect(greetingSlot(12)).toBe("afternoon");
    expect(greetingSlot(17)).toBe("afternoon");
    expect(greetingSlot(18)).toBe("evening");
    expect(greetingSlot(23)).toBe("evening");
  });
});

describe("firstName", () => {
  it("takes the first word", () => {
    expect(firstName("Ada Lovelace")).toBe("Ada");
    expect(firstName("  Grace   Hopper ")).toBe("Grace");
    expect(firstName("Cher")).toBe("Cher");
  });

  it("returns null when there is no name to use", () => {
    expect(firstName(null)).toBeNull();
    expect(firstName(undefined)).toBeNull();
    expect(firstName("")).toBeNull();
    expect(firstName("   ")).toBeNull();
  });
});
