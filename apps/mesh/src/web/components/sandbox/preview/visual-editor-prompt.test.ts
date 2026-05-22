import { describe, test, expect } from "bun:test";
import {
  formatVisualEditorMessage,
  computePromptPosition,
} from "./visual-editor-prompt";
import type { VisualEditorPayload } from "./visual-editor-script";

const basePayload: VisualEditorPayload = {
  tag: "button",
  id: "submit",
  classes: "btn btn-primary",
  text: "Click me",
  html: '<button class="btn">Click me</button>',
  manifestKey: null,
  componentName: null,
  parents: "div.container > form",
  url: "http://localhost:3000/",
  path: "/",
  viewport: { width: 1920, height: 1080 },
  position: { x: 500, y: 300 },
};

describe("formatVisualEditorMessage", () => {
  test("includes the user prompt", () => {
    const msg = formatVisualEditorMessage(basePayload, "make this red");
    expect(msg).toContain('**"make this red"**');
  });

  test("includes clicked element selector", () => {
    const msg = formatVisualEditorMessage(basePayload, "test");
    expect(msg).toContain('<button class="btn btn-primary">');
  });

  test("includes DOM breadcrumb", () => {
    const msg = formatVisualEditorMessage(basePayload, "test");
    expect(msg).toContain("div.container > form > button");
  });

  test("includes text content", () => {
    const msg = formatVisualEditorMessage(basePayload, "test");
    expect(msg).toContain('"Click me"');
  });

  test("includes HTML snippet in code fence", () => {
    const msg = formatVisualEditorMessage(basePayload, "test");
    expect(msg).toContain("```html");
    expect(msg).toContain("</button>");
  });

  test("escapes triple backticks in html", () => {
    const payload = { ...basePayload, html: "test```injection" };
    const msg = formatVisualEditorMessage(payload, "test");
    expect(msg).not.toContain("test```injection");
    expect(msg).toContain("test`` `injection");
  });

  test("includes manifestKey when present", () => {
    const payload = {
      ...basePayload,
      manifestKey: "site/sections/Hero.tsx",
    };
    const msg = formatVisualEditorMessage(payload, "test");
    expect(msg).toContain("site/sections/Hero.tsx");
  });

  test("omits manifestKey when null", () => {
    const msg = formatVisualEditorMessage(basePayload, "test");
    expect(msg).not.toContain("Section source file");
  });

  test("includes componentName when present", () => {
    const payload = { ...basePayload, componentName: "HeroSection" };
    const msg = formatVisualEditorMessage(payload, "test");
    expect(msg).toContain("HeroSection");
  });

  test("sanitizes markdown special chars in text", () => {
    const payload = {
      ...basePayload,
      text: "click `here` for **bold**",
    };
    const msg = formatVisualEditorMessage(payload, "test");
    expect(msg).not.toContain("`here`");
  });
});

describe("computePromptPosition", () => {
  test("centers horizontally on click position", () => {
    const pos = computePromptPosition(
      { x: 500, y: 300 },
      { width: 1920, height: 1080 },
    );
    // left = max(12, min(500-160, 1920-320-12)) = max(12, 340) = 340
    expect(pos.leftPct).toBeCloseTo((340 / 1920) * 100, 1);
  });

  test("clamps to left edge", () => {
    const pos = computePromptPosition(
      { x: 10, y: 300 },
      { width: 1920, height: 1080 },
    );
    // left = max(12, min(10-160, ...)) = max(12, -150) = 12
    expect(pos.leftPct).toBeCloseTo((12 / 1920) * 100, 1);
  });

  test("clamps to right edge", () => {
    const pos = computePromptPosition(
      { x: 1910, y: 300 },
      { width: 1920, height: 1080 },
    );
    // left = max(12, min(1910-160, 1920-320-12)) = max(12, min(1750, 1588)) = 1588
    expect(pos.leftPct).toBeCloseTo((1588 / 1920) * 100, 1);
  });

  test("places below click when in upper area", () => {
    const pos = computePromptPosition(
      { x: 500, y: 300 },
      { width: 1920, height: 1080 },
    );
    // isNearBottom = 300/1080 = 0.28 < 0.68 → below
    // top = min(300+18, 1080-44-12) = min(318, 1024) = 318
    expect(pos.topPct).toBeCloseTo((318 / 1080) * 100, 1);
  });

  test("places above click when near bottom", () => {
    const pos = computePromptPosition(
      { x: 500, y: 900 },
      { width: 1920, height: 1080 },
    );
    // isNearBottom = 900/1080 = 0.83 > 0.68 → above
    // top = max(12, 900-44-18) = max(12, 838) = 838
    expect(pos.topPct).toBeCloseTo((838 / 1080) * 100, 1);
  });
});
