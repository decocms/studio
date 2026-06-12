import { describe, expect, test } from "bun:test";
import {
  buildDirectDaemonEventsUrl,
  isDirectDaemonEventsGoneStatus,
} from "./sandbox-events-context";

describe("buildDirectDaemonEventsUrl", () => {
  test("routes daemon events through the preview origin root", () => {
    expect(
      buildDirectDaemonEventsUrl("https://abc.preview.example.com/app/page"),
    ).toBe("https://abc.preview.example.com/_sandbox/events");
  });

  test("preserves local desktop preview origin", () => {
    expect(buildDirectDaemonEventsUrl("http://h1.localhost:4000")).toBe(
      "http://h1.localhost:4000/_sandbox/events",
    );
  });

  test("returns null for missing or invalid preview URLs", () => {
    expect(buildDirectDaemonEventsUrl(null)).toBeNull();
    expect(buildDirectDaemonEventsUrl("not a url")).toBeNull();
  });
});

describe("isDirectDaemonEventsGoneStatus", () => {
  test("maps preview 404 to sandbox gone", () => {
    expect(isDirectDaemonEventsGoneStatus(404)).toBe(true);
  });

  test("does not map transient preview errors to sandbox gone", () => {
    expect(isDirectDaemonEventsGoneStatus(429)).toBe(false);
    expect(isDirectDaemonEventsGoneStatus(502)).toBe(false);
    expect(isDirectDaemonEventsGoneStatus(503)).toBe(false);
  });
});
