import { describe, expect, test } from "bun:test";
import { STEP_DEFS, buildSteps } from "./steps";
import { TOUR_ANCHORS, tourAnchorSelector } from "./anchors";

// A stub t() that echoes the key, so we can assert wiring without the real dict.
const t = ((key: string) => key) as unknown as Parameters<typeof buildSteps>[0];

describe("cms-tour steps", () => {
  test("walks the controls in the intended flow order", () => {
    expect(STEP_DEFS.map((s) => s.anchor)).toEqual([
      "previewTab",
      "dropdown",
      "edit",
      "visualEditor",
      "device",
      "branches",
      "submit",
      "publish",
    ]);
  });

  test("every step anchor is a real TOUR_ANCHORS entry", () => {
    for (const step of STEP_DEFS) {
      expect(TOUR_ANCHORS[step.anchor]).toBeDefined();
    }
  });

  test("buildSteps resolves each anchor to its data-tour selector", () => {
    const steps = buildSteps(t);
    expect(steps).toHaveLength(STEP_DEFS.length);
    steps.forEach((step, i) => {
      expect(step.element).toBe(tourAnchorSelector(STEP_DEFS[i]!.anchor));
      // popover carries the (stubbed) i18n keys, proving title/description wiring
      expect(step.popover?.title).toBe(STEP_DEFS[i]!.titleKey);
      expect(step.popover?.description).toBe(STEP_DEFS[i]!.descKey);
    });
  });
});
