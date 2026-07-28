import { describe, expect, test } from "bun:test";
import {
  buildDirectDaemonEventsUrl,
  isDirectDaemonEventsGoneStatus,
  isLiveMetaKeyForScope,
  isWorkingTreeReadyPhase,
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

describe("isLiveMetaKeyForScope", () => {
  test("matches a live-meta key regardless of its previewUrl suffix", () => {
    expect(
      isLiveMetaKeyForScope(
        ["live-meta", "acme", "vmid-1", "main", "https://preview.example.com"],
        "acme",
        "vmid-1",
        "main",
      ),
    ).toBe(true);
  });

  test("does not match a different org, vmid, or branch", () => {
    const scope = [
      "live-meta",
      "acme",
      "vmid-1",
      "main",
      "https://x.example.com",
    ];
    expect(isLiveMetaKeyForScope(scope, "other-org", "vmid-1", "main")).toBe(
      false,
    );
    expect(isLiveMetaKeyForScope(scope, "acme", "other-vmid", "main")).toBe(
      false,
    );
    expect(isLiveMetaKeyForScope(scope, "acme", "vmid-1", "other-branch")).toBe(
      false,
    );
  });
});

describe("isWorkingTreeReadyPhase", () => {
  test("false before the repo is on disk", () => {
    // The cold-start window that strands Fast Preview: the daemon answers, but
    // `.deco/blocks/` doesn't exist, so /read 400s and useDecofile 502s.
    expect(isWorkingTreeReadyPhase("idle")).toBe(false);
    expect(isWorkingTreeReadyPhase("cloning")).toBe(false);
    expect(isWorkingTreeReadyPhase("clone-failed")).toBe(false);
  });

  test("checking-out is excluded — the tree is mid-write", () => {
    expect(isWorkingTreeReadyPhase("checking-out")).toBe(false);
  });

  test("installing is the trigger — clone done, deps pending", () => {
    // Precisely the window Fast Preview exists to render in.
    expect(isWorkingTreeReadyPhase("installing")).toBe(true);
  });

  test("later phases also count — a warm sandbox can skip past installing", () => {
    expect(isWorkingTreeReadyPhase("starting")).toBe(true);
    expect(isWorkingTreeReadyPhase("running")).toBe(true);
  });

  test("failure phases count — a failed install still leaves a readable tree", () => {
    expect(isWorkingTreeReadyPhase("install-failed")).toBe(true);
    expect(isWorkingTreeReadyPhase("start-failed")).toBe(true);
    expect(isWorkingTreeReadyPhase("crashed")).toBe(true);
  });
});
