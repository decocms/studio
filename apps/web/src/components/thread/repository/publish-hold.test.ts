import { setupComponentTest } from "../../../../test/setup";
setupComponentTest();
import { describe, expect, it } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import { shownPublishList, usePublishHold } from "./publish-hold";

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
  it("a hosted Publish keeps showing the list it publishes through the dialog's close, never the emptied draft's re-read", () => {
    // While it runs, and once it ended and the dialog closes (fades out).
    expect(shownPublishList(listed, emptied, { hosted: true })).toBe(listed);
  });

  it("shows the live list otherwise", () => {
    // Gated to hosted v8: every other Publish renders as before.
    expect(shownPublishList(listed, emptied, { hosted: false })).toBe(emptied);
    expect(shownPublishList(null, emptied, { hosted: true })).toBe(emptied);
  });
});

describe("usePublishHold (the Publish dialog's list)", () => {
  it("never shows the emptied draft between the Publish's end and the dialog's fade", () => {
    type Props = { live: typeof listed };
    const { result, rerender } = renderHook(
      ({ live }: Props) => usePublishHold(live, { hosted: true }),
      { initialProps: { live: listed } as Props },
    );
    act(() => result.current.hold());
    // The Publish ended (it emptied the draft) and the dialog fades out.
    rerender({ live: emptied });
    expect(result.current.shown).toBe(listed);
    // A failed one shows what the draft holds now.
    act(() => result.current.release());
    expect(result.current.shown).toBe(emptied);
  });
});
