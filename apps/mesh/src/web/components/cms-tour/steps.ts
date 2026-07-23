import type { DriveStep } from "driver.js";
import type { TFunction } from "@/web/i18n/use-t";
import { TOUR_ANCHORS, tourAnchorSelector } from "./anchors";

type AnchorName = keyof typeof TOUR_ANCHORS;

export type StepDef = {
  anchor: AnchorName;
  titleKey: Parameters<TFunction>[0];
  descKey: Parameters<TFunction>[0];
  side: NonNullable<DriveStep["popover"]>["side"];
};

// Ordered by the natural editing flow: see the site → find the other views →
// edit it → edit visually → check it responsively → manage where the changes
// live → submit → publish. Anchors that aren't on screen (e.g. the branch pill
// on a template with no connected repo) are skipped via `skipMissingElement`.
export const STEP_DEFS: StepDef[] = [
  {
    anchor: "previewTab",
    titleKey: "cmsTour.preview.title",
    descKey: "cmsTour.preview.description",
    side: "bottom",
  },
  {
    anchor: "dropdown",
    titleKey: "cmsTour.dropdown.title",
    descKey: "cmsTour.dropdown.description",
    side: "bottom",
  },
  {
    anchor: "edit",
    titleKey: "cmsTour.edit.title",
    descKey: "cmsTour.edit.description",
    side: "bottom",
  },
  {
    anchor: "visualEditor",
    titleKey: "cmsTour.visualEditor.title",
    descKey: "cmsTour.visualEditor.description",
    side: "top",
  },
  {
    anchor: "device",
    titleKey: "cmsTour.device.title",
    descKey: "cmsTour.device.description",
    side: "top",
  },
  {
    anchor: "branches",
    titleKey: "cmsTour.branches.title",
    descKey: "cmsTour.branches.description",
    side: "bottom",
  },
  {
    anchor: "submit",
    titleKey: "cmsTour.submit.title",
    descKey: "cmsTour.submit.description",
    side: "bottom",
  },
  {
    anchor: "publish",
    titleKey: "cmsTour.publish.title",
    descKey: "cmsTour.publish.description",
    side: "bottom",
  },
];

export function buildSteps(t: TFunction): DriveStep[] {
  // NOTE: every value handed to a popover (title/description/button text) MUST
  // be a static i18n string. driver.js renders title/description via innerHTML,
  // so interpolating dynamic content (branch/page/agent names) here would be an
  // XSS sink.
  return STEP_DEFS.map((step) => ({
    element: tourAnchorSelector(step.anchor),
    popover: {
      title: t(step.titleKey),
      description: t(step.descKey),
      side: step.side,
      align: "center",
    },
  }));
}
