import { describe, expect, it } from "bun:test";
import { resolveTargetOrg, type WhatsappEnabledOrg } from "./whatsapp-ingest";

const A: WhatsappEnabledOrg = { orgId: "o-a", orgName: "Alpha", agentId: "ag" };
const B: WhatsappEnabledOrg = { orgId: "o-b", orgName: "Beta", agentId: "ag" };
const C: WhatsappEnabledOrg = { orgId: "o-c", orgName: "Gamma", agentId: "ag" };

describe("resolveTargetOrg", () => {
  it("none when the user has no enabled orgs", () => {
    expect(
      resolveTargetOrg({ text: "hi", orgs: [], selectedOrgId: null }),
    ).toEqual({
      kind: "none",
    });
  });

  it("routes straight through with a single org", () => {
    expect(
      resolveTargetOrg({ text: "hello", orgs: [A], selectedOrgId: null }),
    ).toEqual({ kind: "route", org: A });
  });

  it("routes to the remembered selection when still enabled", () => {
    expect(
      resolveTargetOrg({ text: "hello", orgs: [A, B], selectedOrgId: "o-b" }),
    ).toEqual({ kind: "route", org: B });
  });

  it("asks the user to pick when multiple and none selected", () => {
    expect(
      resolveTargetOrg({ text: "hello", orgs: [A, B], selectedOrgId: null }),
    ).toEqual({ kind: "pick" });
  });

  it("selects by a bare number against the sorted list", () => {
    expect(
      resolveTargetOrg({ text: "2", orgs: [A, B, C], selectedOrgId: null }),
    ).toEqual({ kind: "select", org: B });
  });

  it("ignores out-of-range numbers (still pick)", () => {
    expect(
      resolveTargetOrg({ text: "9", orgs: [A, B], selectedOrgId: null }),
    ).toEqual({ kind: "pick" });
  });

  it("treats numeric input as chat once an org is selected (route, not re-select)", () => {
    expect(
      resolveTargetOrg({ text: "2", orgs: [A, B], selectedOrgId: "o-a" }),
    ).toEqual({ kind: "route", org: A });
  });

  it("recognizes switch commands (case-insensitive)", () => {
    for (const t of ["switch", "/switch", "Orgs", " /orgs "]) {
      expect(
        resolveTargetOrg({ text: t, orgs: [A, B], selectedOrgId: "o-a" }),
      ).toEqual({ kind: "switch" });
    }
  });
});
