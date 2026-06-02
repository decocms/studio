import { describe, expect, test } from "bun:test";
import {
  DEFAULT_CHAT_PANEL_WIDTH,
  normalizePanelSizePercent,
} from "./use-chat-panel-width";

describe("normalizePanelSizePercent", () => {
  test("returns numbers unchanged", () => {
    expect(normalizePanelSizePercent(45)).toBe(45);
  });

  test("coerces numeric strings", () => {
    expect(normalizePanelSizePercent("45")).toBe(45);
  });

  test("falls back for invalid values", () => {
    expect(normalizePanelSizePercent("abc", 30)).toBe(30);
    expect(normalizePanelSizePercent(0)).toBe(DEFAULT_CHAT_PANEL_WIDTH);
    expect(normalizePanelSizePercent(100)).toBe(DEFAULT_CHAT_PANEL_WIDTH);
  });
});
