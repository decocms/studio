import { describe, expect, it } from "bun:test";
import { parseTitle, slashCommands } from "./slash";

const JOBS = ["Role", "Bounty", "Gig"];

describe("parseTitle", () => {
  it("picks the kind a command names, in any alias", () => {
    expect(parseTitle("/bounty Port the header", JOBS)).toEqual({
      type: "topic",
      kind: "Bounty",
      title: "Port the header",
    });
    expect(parseTitle("/VAGA Senior FDE", JOBS)).toEqual({
      type: "topic",
      kind: "Role",
      title: "Senior FDE",
    });
  });

  it("asks for a score on any channel", () => {
    expect(parseTitle("/score shop.com.br", [])).toEqual({
      type: "score",
      domain: "shop.com.br",
    });
  });

  it("keeps the text when the command is unknown or not in the channel", () => {
    expect(parseTitle("/proposal Ship it", JOBS)).toEqual({
      type: "topic",
      kind: null,
      title: "/proposal Ship it",
    });
    expect(parseTitle("  Plain title ", JOBS)).toEqual({
      type: "topic",
      kind: null,
      title: "Plain title",
    });
  });
});

describe("slashCommands", () => {
  it("offers one command per channel kind, then /score", () => {
    expect(slashCommands(JOBS).map((c) => c.command)).toEqual([
      "role",
      "bounty",
      "gig",
      "score",
    ]);
  });
});
