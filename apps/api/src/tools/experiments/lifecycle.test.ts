/**
 * The status an operator drives by hand: `draft` while they iterate, the rest
 * once they have started the test. Pure; `EXPERIMENT_UPDATE` applies these.
 */

import { describe, expect, it } from "bun:test";
import {
  canTransition,
  changesStructure,
  structureEditable,
  transitionError,
} from "./lifecycle";

describe("canTransition", () => {
  it("starts a draft, and nothing else", () => {
    expect(canTransition("draft", "running")).toBe(true);
    expect(canTransition("draft", "paused")).toBe(false);
    expect(canTransition("draft", "ended")).toBe(false);
  });

  it("pauses, resumes and ends a started experiment", () => {
    expect(canTransition("running", "paused")).toBe(true);
    expect(canTransition("running", "ended")).toBe(true);
    expect(canTransition("paused", "running")).toBe(true);
    expect(canTransition("paused", "ended")).toBe(true);
  });

  it("never sends a started experiment back to draft", () => {
    expect(canTransition("running", "draft")).toBe(false);
    expect(canTransition("paused", "draft")).toBe(false);
    expect(canTransition("ended", "draft")).toBe(false);
  });

  it("leaves an ended experiment ended", () => {
    expect(canTransition("ended", "running")).toBe(false);
    expect(canTransition("ended", "paused")).toBe(false);
  });

  it("allows the no-op patch that re-sends the current status", () => {
    for (const s of ["draft", "running", "paused", "ended"] as const) {
      expect(canTransition(s, s)).toBe(true);
    }
  });
});

describe("transitionError", () => {
  it("says the test already started when something asks for draft", () => {
    expect(transitionError("running", "draft")).toContain("back to draft");
  });

  it("says an ended experiment is final", () => {
    expect(transitionError("ended", "running")).toContain("has ended");
  });

  it("names both ends of any other refused move", () => {
    expect(transitionError("draft", "paused")).toBe(
      "An experiment cannot go from draft to paused.",
    );
  });
});

describe("structureEditable", () => {
  it("is the draft, and only the draft", () => {
    expect(structureEditable("draft")).toBe(true);
    expect(structureEditable("running")).toBe(false);
    expect(structureEditable("paused")).toBe(false);
    expect(structureEditable("ended")).toBe(false);
  });
});

describe("changesStructure", () => {
  const arms = [{ id: "control" }, { id: "treatment" }];

  it("ignores a reweight — same arms, same structure", () => {
    expect(
      changesStructure(arms, [{ id: "control" }, { id: "treatment" }]),
    ).toBe(false);
  });

  it("ignores the order the arms arrive in", () => {
    expect(
      changesStructure(arms, [{ id: "treatment" }, { id: "control" }]),
    ).toBe(false);
  });

  it("catches a renamed, added or dropped arm", () => {
    expect(changesStructure(arms, [{ id: "control" }, { id: "b" }])).toBe(true);
    expect(changesStructure(arms, [...arms, { id: "treatment-2" }])).toBe(true);
    expect(changesStructure(arms, [{ id: "control" }])).toBe(true);
  });
});
