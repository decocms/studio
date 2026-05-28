import { describe, expect, it } from "bun:test";
import {
  accessTabWhereValue,
  coerceConnectionAccessTab,
  countConnectionsByAccess,
  filterConnectionsByAccessTab,
} from "./connection-access-tab";

const conns = [
  { access: "org" as const },
  { access: "user" as const },
  { access: "user" as const },
];

describe("coerceConnectionAccessTab", () => {
  it("keeps valid tabs", () => {
    expect(coerceConnectionAccessTab("all")).toBe("all");
    expect(coerceConnectionAccessTab("shared")).toBe("shared");
    expect(coerceConnectionAccessTab("personal")).toBe("personal");
  });

  it("maps legacy and unknown values to all", () => {
    expect(coerceConnectionAccessTab("connected")).toBe("all");
    expect(coerceConnectionAccessTab(undefined)).toBe("all");
    expect(coerceConnectionAccessTab("bogus")).toBe("all");
  });
});

describe("accessTabWhereValue", () => {
  it("maps tabs to the access column value", () => {
    expect(accessTabWhereValue("all")).toBeNull();
    expect(accessTabWhereValue("shared")).toBe("org");
    expect(accessTabWhereValue("personal")).toBe("user");
  });
});

describe("filterConnectionsByAccessTab", () => {
  it("returns everything for the all tab", () => {
    expect(filterConnectionsByAccessTab(conns, "all")).toHaveLength(3);
  });

  it("returns only org connections for shared", () => {
    expect(filterConnectionsByAccessTab(conns, "shared")).toEqual([
      { access: "org" },
    ]);
  });

  it("returns only user connections for personal", () => {
    expect(filterConnectionsByAccessTab(conns, "personal")).toEqual([
      { access: "user" },
      { access: "user" },
    ]);
  });
});

describe("countConnectionsByAccess", () => {
  it("counts each bucket", () => {
    expect(countConnectionsByAccess(conns)).toEqual({
      all: 3,
      shared: 1,
      personal: 2,
    });
  });
});
