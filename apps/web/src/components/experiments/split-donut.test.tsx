import { setupComponentTest } from "../../../test/setup";
setupComponentTest();
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import {
  armColors,
  clampShare,
  CONTROL_COLOR,
  PRIMARY_COLOR,
  ShareSplit,
  shareArms,
} from "./split-donut";

afterEach(cleanup);

describe("split donut", () => {
  test("a share is a whole number from 0 to 100", () => {
    expect(clampShare(40)).toBe(40);
    expect(clampShare(40.6)).toBe(41);
    expect(clampShare(-3)).toBe(0);
    expect(clampShare(140)).toBe(100);
    expect(clampShare(Number.NaN)).toBe(0);
  });

  test("a v8 test's share is two sides: in the test and the rest", () => {
    expect(shareArms(30)).toEqual([
      { id: "in-test", role: "treatment", weight: 30 },
      { id: "rest", role: "control", weight: 70 },
    ]);
    expect(shareArms(0).map((a) => a.weight)).toEqual([0, 100]);
    expect(shareArms(100).map((a) => a.weight)).toEqual([100, 0]);
  });

  test("the control is the neutral, the first treatment the primary", () => {
    expect(armColors(shareArms(50))).toEqual([PRIMARY_COLOR, CONTROL_COLOR]);
    const colors = armColors([
      { role: "control" },
      { role: "treatment" },
      { role: "treatment" },
    ]);
    expect(colors[0]).toBe(CONTROL_COLOR);
    expect(colors[1]).toBe(PRIMARY_COLOR);
    expect(colors[2]).not.toBe(PRIMARY_COLOR);
  });
});

function Harness({
  initial,
  onCommit,
}: {
  initial: number;
  onCommit?: (value: number) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <ShareSplit
      value={value}
      onChange={setValue}
      onCommit={onCommit}
      sliderLabel="Visitors who see the test"
      inTestLabel="See the test"
      restLabel="See the page as it is"
      centerLabel="see the test"
    />
  );
}

describe("ShareSplit", () => {
  test("shows both sides' percentages and has no number input", () => {
    const view = render(<Harness initial={30} />);
    expect(view.getByTestId("share-split-in").textContent).toBe("30%");
    expect(view.getByTestId("share-split-rest").textContent).toBe("70%");
    expect(view.getByText("See the test")).toBeTruthy();
    expect(view.getByText("See the page as it is")).toBeTruthy();
    expect(view.container.querySelector("input")).toBeNull();
  });

  test("the slider is named, says its value and moves with the keyboard", () => {
    const onCommit = mock((_: number) => {});
    const view = render(<Harness initial={30} onCommit={onCommit} />);
    const thumb = view.getByRole("slider");
    expect(thumb.getAttribute("aria-label")).toBe("Visitors who see the test");
    expect(thumb.getAttribute("aria-valuenow")).toBe("30");
    expect(thumb.getAttribute("aria-valuetext")).toBe("30%");

    fireEvent.keyDown(thumb, { key: "ArrowRight" });
    expect(view.getByTestId("share-split-in").textContent).toBe("31%");
    expect(view.getByTestId("share-split-rest").textContent).toBe("69%");
    expect(onCommit).toHaveBeenLastCalledWith(31);

    fireEvent.keyDown(thumb, { key: "End" });
    expect(view.getByTestId("share-split-in").textContent).toBe("100%");
    fireEvent.keyDown(thumb, { key: "Home" });
    expect(view.getByTestId("share-split-in").textContent).toBe("0%");
    expect(view.getByTestId("share-split-rest").textContent).toBe("100%");
  });
});
