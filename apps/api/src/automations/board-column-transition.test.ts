import { describe, expect, it } from "bun:test";
import {
  automationInstruction,
  cardFireFence,
  restedOrigin,
  transitionMatches,
  triggerFrom,
} from "./board-column-transition";

const trigger = (
  from_kind: "any" | "earlier" | "later" | "statuses",
  from_statuses: string[] = [],
) => ({ column_key: "qa", from_kind, from_statuses });

describe("transitionMatches", () => {
  it("answers any move into its column, and only into it", () => {
    expect(
      transitionMatches(trigger("any"), { from: "in_review", to: "qa" }),
    ).toBe(true);
    expect(transitionMatches(trigger("any"), { from: null, to: "qa" })).toBe(
      true,
    );
    expect(
      transitionMatches(trigger("any"), { from: "qa", to: "in_review" }),
    ).toBe(false);
  });

  it("never fires on a move within one column", () => {
    expect(transitionMatches(trigger("any"), { from: "qa", to: "qa" })).toBe(
      false,
    );
  });

  it("tells a card moving on from one sent back, by board order", () => {
    const forward = { from: "in_review", to: "qa" };
    const back = { from: "customer_approval", to: "qa" };
    expect(transitionMatches(trigger("earlier"), forward)).toBe(true);
    expect(transitionMatches(trigger("earlier"), back)).toBe(false);
    expect(transitionMatches(trigger("later"), back)).toBe(true);
    expect(transitionMatches(trigger("later"), forward)).toBe(false);
  });

  it("matches a list of origins, and nothing without an origin", () => {
    const listed = trigger("statuses", ["in_review"]);
    expect(transitionMatches(listed, { from: "in_review", to: "qa" })).toBe(
      true,
    );
    expect(transitionMatches(listed, { from: "triage", to: "qa" })).toBe(false);
    expect(transitionMatches(listed, { from: null, to: "qa" })).toBe(false);
  });
});

describe("triggerFrom", () => {
  it("drops a stored column the board no longer has", () => {
    expect(
      triggerFrom({ from_kind: "statuses", from_statuses: ["todo", "qa"] }),
    ).toEqual({ kind: "statuses", statuses: ["qa"] });
  });

  it("reads a trigger with no origin rule as any", () => {
    expect(triggerFrom({ from_kind: null, from_statuses: [] })).toEqual({
      kind: "any",
    });
  });
});

describe("restedOrigin", () => {
  const at = (seconds: number) =>
    new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();

  it("is the move's origin when the card rested there", () => {
    expect(
      restedOrigin(
        [
          { from: null, to: "triage", occurredAt: at(0) },
          { from: "triage", to: "in_progress", occurredAt: at(50) },
        ],
        20_000,
      ),
    ).toBe("triage");
  });

  it("skips a column the card was only dragged through", () => {
    expect(
      restedOrigin(
        [
          { from: "triage", to: "qa", occurredAt: at(0) },
          { from: "qa", to: "in_progress", occurredAt: at(5) },
        ],
        20_000,
      ),
    ).toBe("triage");
  });
});

describe("automationInstruction", () => {
  it("joins the text of the user messages", () => {
    expect(
      automationInstruction(
        JSON.stringify([
          { role: "system", parts: [{ type: "text", text: "ignored" }] },
          {
            role: "user",
            parts: [
              { type: "text", text: "Triage the card." },
              { type: "file", url: "x" },
            ],
          },
          { role: "user", parts: [{ type: "text", text: "Label it." }] },
        ]),
      ),
    ).toBe("Triage the card.\n\nLabel it.");
  });

  it("is empty for messages it cannot read", () => {
    expect(automationInstruction("{}")).toBe("");
  });
});

describe("cardFireFence", () => {
  it("is the same for one fire and different across fires", () => {
    expect(cardFireFence("trg_1", "act_1")).toEqual(
      cardFireFence("trg_1", "act_1"),
    );
    expect(cardFireFence("trg_1", "act_1").threadId).not.toBe(
      cardFireFence("trg_1", "act_2").threadId,
    );
    expect(cardFireFence("trg_1", "act_1").threadId).toMatch(
      /^thrd_[0-9a-f]{32}$/,
    );
  });
});
