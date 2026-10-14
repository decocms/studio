import { describe, expect, it } from "bun:test";
import {
  firstName,
  greetingSlot,
  pulseWindow,
  pulseWindowStart,
} from "./greeting";

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

describe("pulseWindow", () => {
  it("calls a morning overnight and the rest of the day today", () => {
    expect(pulseWindow("morning")).toBe("overnight");
    expect(pulseWindow("afternoon")).toBe("today");
    expect(pulseWindow("evening")).toBe("today");
  });
});

describe("pulseWindowStart", () => {
  const at = (hour: number) => new Date(2026, 9, 7, hour, 30);

  it("starts a morning at 18:00 the evening before", () => {
    expect(pulseWindowStart("morning", at(8))).toBe(
      new Date(2026, 9, 6, 18).getTime(),
    );
  });

  it("starts the afternoon and evening at midnight", () => {
    expect(pulseWindowStart("afternoon", at(14))).toBe(
      new Date(2026, 9, 7).getTime(),
    );
    expect(pulseWindowStart("evening", at(21))).toBe(
      new Date(2026, 9, 7).getTime(),
    );
  });
});
