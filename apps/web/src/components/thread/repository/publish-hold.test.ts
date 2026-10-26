import { describe, expect, it } from "bun:test";
import { shownPublishList } from "./publish-hold";

const listed = {
  summary: { count: 2 },
  cardsPending: false,
  bodiesPending: false,
};
const emptied = {
  summary: { count: 0 },
  cardsPending: true,
  bodiesPending: false,
};

describe("shownPublishList", () => {
  it("a hosted Publish keeps showing the list it publishes until it closes, not the emptied draft's re-read", () => {
    expect(
      shownPublishList(listed, emptied, { hosted: true, publishing: true }),
    ).toBe(listed);
  });

  it("shows the live list otherwise", () => {
    expect(
      shownPublishList(listed, emptied, { hosted: true, publishing: false }),
    ).toBe(emptied);
    // Gated to hosted v8: every other Publish renders as before.
    expect(
      shownPublishList(listed, emptied, { hosted: false, publishing: true }),
    ).toBe(emptied);
    expect(
      shownPublishList(null, emptied, { hosted: true, publishing: true }),
    ).toBe(emptied);
  });
});
