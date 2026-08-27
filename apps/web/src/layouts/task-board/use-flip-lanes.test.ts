import { setupComponentTest } from "../../../test/setup";
setupComponentTest();
import { describe, expect, it } from "bun:test";
import { renderHook } from "@testing-library/react";
import { useFlipLanes } from "./use-flip-lanes";

/** Builds `<div data-lane-scroll><div data-flip-id="card" data-flip-lane="..." /></div>`
 *  and lets each render control the card's reported rect, so a lane change can
 *  be simulated without a real layout engine (happy-dom's rects are all 0). */
function setup() {
  const lane = document.createElement("div");
  lane.dataset.laneScroll = "todo";
  const card = document.createElement("div");
  card.dataset.flipId = "card";
  card.dataset.flipLane = "todo";
  lane.appendChild(card);
  document.body.appendChild(lane);

  let rect = { left: 0, top: 0 };
  card.getBoundingClientRect = () =>
    ({ ...rect, right: 0, bottom: 0, width: 0, height: 0 }) as DOMRect;

  const containerRef = { current: lane };
  return {
    lane,
    card,
    containerRef,
    moveTo: (next: { left: number; top: number }, laneName: string) => {
      rect = next;
      card.dataset.flipLane = laneName;
    },
  };
}

describe("useFlipLanes", () => {
  it("resets a lane-changer's lifted overflow clip even if a new signature interrupts the animation before it settles", () => {
    const { lane, containerRef, moveTo } = setup();

    // Stub rAF so the animation never gets to its own settle callback — this
    // stands in for a second lane change landing within the same frame.
    const originalRaf = window.requestAnimationFrame;
    window.requestAnimationFrame = () => 1;

    const { rerender } = renderHook(
      ({ signature }: { signature: string }) =>
        useFlipLanes(containerRef, signature, true),
      { initialProps: { signature: "card:todo" } },
    );

    // Move the card into another lane — triggers the FLIP, which lifts the
    // clip on its home lane synchronously.
    moveTo({ left: 0, top: 300 }, "done");
    rerender({ signature: "card:done" });
    expect(lane.style.overflow).toBe("visible");

    // A second signature change lands before the (stubbed) rAF ever fired —
    // no further movement this time, just tearing the previous effect down.
    rerender({ signature: "card:done:reordered" });

    expect(lane.style.overflow).toBe("");

    window.requestAnimationFrame = originalRaf;
  });

  it("does not animate moves that landed while the board was hidden", () => {
    const { card, containerRef, moveTo } = setup();

    const { rerender } = renderHook(
      ({ signature, visible }: { signature: string; visible: boolean }) =>
        useFlipLanes(containerRef, signature, true, visible),
      { initialProps: { signature: "card:todo", visible: true } },
    );

    // Hidden board: every rect the browser reports collapses to the origin.
    moveTo({ left: 0, top: 0 }, "todo");
    rerender({ signature: "card:todo", visible: false });

    // A card changes lane while nobody is looking.
    moveTo({ left: 0, top: 300 }, "done");
    rerender({ signature: "card:done", visible: false });

    // Back on the board: the card sits where it belongs, not mid-flight.
    rerender({ signature: "card:done", visible: true });
    expect(card.style.transform).toBe("");
    expect(card.style.transition).toBe("");
  });

  it("animates again once the board is back and a card moves in view", () => {
    const { card, containerRef, moveTo } = setup();

    const { rerender } = renderHook(
      ({ signature, visible }: { signature: string; visible: boolean }) =>
        useFlipLanes(containerRef, signature, true, visible),
      { initialProps: { signature: "card:todo", visible: true } },
    );

    rerender({ signature: "card:todo", visible: false });
    rerender({ signature: "card:todo", visible: true });

    moveTo({ left: 0, top: 300 }, "done");
    rerender({ signature: "card:done", visible: true });

    expect(card.style.transform).toContain("translate(0px, -300px)");
  });
});
