import { describe, expect, it } from "bun:test";
import {
  directionOf,
  fromKey,
  needsDirection,
  normalizeFrom,
  pickRule,
  type RuleFrom,
  ruleConflict,
  ruleFromColumns,
  sharedStatuses,
} from "./rule-from";

const rule = (name: string, from: RuleFrom) => ({ name, from });

describe("normalizeFrom / fromKey", () => {
  it("makes the same list typed twice the same rule", () => {
    const a: RuleFrom = { kind: "statuses", statuses: [" QA ", "Backlog"] };
    const b: RuleFrom = { kind: "statuses", statuses: ["backlog", "qa", "QA"] };
    expect(normalizeFrom(a)).toEqual({
      kind: "statuses",
      statuses: ["Backlog", "QA"],
    });
    expect(fromKey(a)).toBe(fromKey(b));
    expect(fromKey(a)).toBe("statuses:backlog\nqa");
  });

  it("keys the other kinds by their name", () => {
    expect(fromKey({ kind: "any" })).toBe("any");
    expect(fromKey({ kind: "earlier" })).toBe("earlier");
    expect(fromKey({ kind: "later" })).toBe("later");
  });
});

describe("sharedStatuses", () => {
  it("finds a status two lists both claim, whatever the case", () => {
    expect(
      sharedStatuses(
        { kind: "statuses", statuses: ["QA", "Review"] },
        { kind: "statuses", statuses: ["qa"] },
      ),
    ).toEqual(["QA"]);
    expect(
      sharedStatuses({ kind: "statuses", statuses: ["QA"] }, { kind: "any" }),
    ).toEqual([]);
  });
});

describe("pickRule", () => {
  const rules = [
    rule("any", { kind: "any" }),
    rule("back", { kind: "later" }),
    rule("forward", { kind: "earlier" }),
    rule("from-qa", { kind: "statuses", statuses: ["Client QA"] }),
  ];

  it("prefers a list naming the origin, then the direction, then any", () => {
    expect(pickRule(rules, "client qa", "later")?.name).toBe("from-qa");
    expect(pickRule(rules, "Review", "later")?.name).toBe("back");
    expect(pickRule(rules, "Backlog", "earlier")?.name).toBe("forward");
    expect(pickRule(rules, "Product Ops", null)?.name).toBe("any");
  });

  it("answers nothing when no rule covers the move", () => {
    const onlyBack = [rule("back", { kind: "later" })];
    expect(pickRule(onlyBack, "Backlog", "earlier")).toBeNull();
    expect(pickRule(onlyBack, null, null)).toBeNull();
    expect(pickRule([], "Backlog", "earlier")).toBeNull();
  });
});

describe("directionOf", () => {
  const columns = [["s-backlog"], ["s-doing"], ["s-review", "s-blocked"]];

  it("reads the board's left-to-right order", () => {
    expect(directionOf(columns, "s-backlog", "s-review")).toBe("earlier");
    expect(directionOf(columns, "s-review", "s-doing")).toBe("later");
  });

  it("has no direction inside one column or off the board", () => {
    expect(directionOf(columns, "s-blocked", "s-review")).toBeNull();
    expect(directionOf(columns, "s-elsewhere", "s-review")).toBeNull();
    expect(directionOf(columns, null, "s-review")).toBeNull();
  });
});

describe("needsDirection", () => {
  it("is only true when a rule answers by direction", () => {
    expect(needsDirection([rule("a", { kind: "any" })])).toBe(false);
    expect(needsDirection([rule("b", { kind: "later" })])).toBe(true);
  });
});

describe("ruleConflict", () => {
  const statuses = (...names: string[]): RuleFrom => ({
    kind: "statuses",
    statuses: names,
  });

  it("lets a status carry one trigger per origin", () => {
    expect(
      ruleConflict("Doing", { kind: "later" }, [
        { kind: "any" },
        { kind: "earlier" },
        statuses("Backlog"),
      ]),
    ).toBeNull();
    expect(ruleConflict("Doing", { kind: "any" }, [])).toBeNull();
  });

  it("refuses a second trigger for the same origin", () => {
    expect(ruleConflict("Doing", { kind: "any" }, [{ kind: "any" }])).toContain(
      'Another trigger on "Doing" already answers the same origin',
    );
    // The same list in another order and case is the same origin.
    expect(
      ruleConflict("Doing", statuses("client qa", "BACKLOG"), [
        statuses("Backlog", "Client QA"),
      ]),
    ).toContain("same origin");
  });

  it("refuses two lists that name the same status", () => {
    expect(
      ruleConflict("Doing", statuses("Code Review", "teste"), [
        statuses("Teste"),
      ]),
    ).toContain('already answers moves from "teste"');
  });
});

describe("ruleFromColumns", () => {
  it("reads a trigger's origin, any when unset", () => {
    expect(ruleFromColumns({ from_kind: null, from_statuses: [] })).toEqual({
      kind: "any",
    });
    expect(ruleFromColumns({ from_kind: "later", from_statuses: [] })).toEqual({
      kind: "later",
    });
    expect(
      ruleFromColumns({ from_kind: "statuses", from_statuses: ["QA"] }),
    ).toEqual({ kind: "statuses", statuses: ["QA"] });
  });
});
