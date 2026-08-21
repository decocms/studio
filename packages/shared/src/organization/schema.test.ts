import { describe, expect, it } from "bun:test";
import {
  DEFAULT_ON_FLAGS,
  NEW_ORG_DEFAULT_FLAGS,
  OrgFlagsSchema,
  SprintConfigSchema,
  orgFlagEnabled,
  parseCalendarDay,
} from "./schema";

describe("orgFlagEnabled", () => {
  it("default-on flags read as enabled unless stored exactly false", () => {
    expect(DEFAULT_ON_FLAGS.has("qa_agent_enabled")).toBe(true);
    // unset / null / true → on; only explicit false opts out.
    expect(orgFlagEnabled(null, "qa_agent_enabled")).toBe(true);
    expect(orgFlagEnabled(undefined, "qa_agent_enabled")).toBe(true);
    expect(orgFlagEnabled({}, "qa_agent_enabled")).toBe(true);
    expect(orgFlagEnabled({ qa_agent_enabled: null }, "qa_agent_enabled")).toBe(
      true,
    );
    expect(orgFlagEnabled({ qa_agent_enabled: true }, "qa_agent_enabled")).toBe(
      true,
    );
    expect(
      orgFlagEnabled({ qa_agent_enabled: false }, "qa_agent_enabled"),
    ).toBe(false);
  });

  it("default-off flags read as disabled unless stored exactly true", () => {
    expect(DEFAULT_ON_FLAGS.has("auto_merge")).toBe(false);
    expect(orgFlagEnabled(null, "auto_merge")).toBe(false);
    expect(orgFlagEnabled(undefined, "auto_merge")).toBe(false);
    expect(orgFlagEnabled({}, "auto_merge")).toBe(false);
    expect(orgFlagEnabled({ auto_merge: null }, "auto_merge")).toBe(false);
    expect(orgFlagEnabled({ auto_merge: false }, "auto_merge")).toBe(false);
    expect(orgFlagEnabled({ auto_merge: true }, "auto_merge")).toBe(true);
  });

  it("a non-boolean stored value follows the branch's strict comparison", () => {
    // Reads hit raw jsonb, bypassing zod: only a strict boolean flips the gate.
    expect(
      orgFlagEnabled({ qa_agent_enabled: "true" }, "qa_agent_enabled"),
    ).toBe(true);
    expect(orgFlagEnabled({ auto_merge: "true" }, "auto_merge")).toBe(false);
  });
});

describe("NEW_ORG_DEFAULT_FLAGS", () => {
  it("only contains keys the flags schema declares", () => {
    // The seed writes through storage, bypassing the tool's .strict() parse.
    expect(
      OrgFlagsSchema.strict().safeParse(NEW_ORG_DEFAULT_FLAGS).success,
    ).toBe(true);
  });

  it("starts new orgs on the first-class navigation", () => {
    expect(NEW_ORG_DEFAULT_FLAGS.nav_v2).toBe(true);
  });

  it("is a stored-value mechanism, not a read-time default", () => {
    // DEFAULT_ON_FLAGS is read-time: it would flip existing orgs too.
    for (const flag of Object.keys(NEW_ORG_DEFAULT_FLAGS)) {
      expect(
        DEFAULT_ON_FLAGS.has(flag as keyof typeof NEW_ORG_DEFAULT_FLAGS),
      ).toBe(false);
    }
    expect(orgFlagEnabled({}, "nav_v2")).toBe(false);
  });
});

describe("SprintConfigSchema.startDate", () => {
  const config = (startDate: string) => ({
    enabled: true,
    weeks: 2,
    startDate,
  });

  it("accepts a real calendar day", () => {
    expect(SprintConfigSchema.safeParse(config("2026-01-05")).success).toBe(
      true,
    );
    // Leap day in a leap year is a real day.
    expect(SprintConfigSchema.safeParse(config("2024-02-29")).success).toBe(
      true,
    );
  });

  it("rejects a well-formed day that does not exist", () => {
    // `Date.parse` rolls these over instead of failing — 2026-02-31 reads back
    // as March 3, which would slide every sprint boundary three days.
    for (const day of ["2026-02-31", "2026-02-29", "2026-04-31"]) {
      expect(SprintConfigSchema.safeParse(config(day)).success).toBe(false);
      expect(parseCalendarDay(day)).toBe(null);
    }
  });

  it("rejects the wrong shape outright", () => {
    for (const day of ["2026-1-5", "05/01/2026", "2026-13-01", "nope", ""]) {
      expect(SprintConfigSchema.safeParse(config(day)).success).toBe(false);
      expect(parseCalendarDay(day)).toBe(null);
    }
  });

  it("parses an accepted day as UTC midnight", () => {
    expect(parseCalendarDay("2026-01-05")).toBe(
      Date.parse("2026-01-05T00:00:00.000Z"),
    );
  });
});
