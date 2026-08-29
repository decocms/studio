/**
 * `shippedPatch` is the one place every ship/archive route builds its status
 * write — pure, so unit-tested directly rather than through a fake ctx.
 */

import { describe, expect, it } from "bun:test";
import type { BoardHandler } from "./board-handler";
import { shippedPatch } from "./board-handler";

const boardWithOwner = (columnOwner: string | null): BoardHandler =>
  ({ columnOwner: () => columnOwner }) as BoardHandler;

describe("shippedPatch", () => {
  it("leaves boardColumnOrg null on Studio's own board", () => {
    expect(shippedPatch(boardWithOwner(null), "done")).toEqual({
      status: "done",
      boardColumnOrg: null,
    });
  });

  // The guard that #6725/#6739 each had to add by hand at their own call site.
  it("carries the org discriminator on an org-owned board", () => {
    expect(shippedPatch(boardWithOwner("org-1"), "merged")).toEqual({
      status: "merged",
      boardColumnOrg: "org-1",
    });
  });
});
