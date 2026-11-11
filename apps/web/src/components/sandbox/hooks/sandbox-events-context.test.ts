import { describe, expect, test } from "bun:test";
import {
  buildDirectDaemonEventsUrl,
  isDenoTaskCommand,
  isDirectDaemonEventsGoneStatus,
  isWorkingTreeReadyPhase,
} from "./sandbox-events-context";

describe("buildDirectDaemonEventsUrl", () => {
  test("routes daemon events through the preview origin root", () => {
    expect(
      buildDirectDaemonEventsUrl("https://abc.preview.example.com/app/page"),
    ).toBe("https://abc.preview.example.com/_sandbox/events");
  });

  test("preserves a localhost preview origin", () => {
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

/**
 * A repo imported without a runtime picked still runs on Deno when it has a
 * `deno.json`; its dev task's command is how the stream tells, so a Blocks
 * save reloads its preview as a project set to Deno does.
 */
describe("isDenoTaskCommand", () => {
  test("the daemon's Deno dev task", () => {
    expect(
      isDenoTaskCommand(
        "export PATH=/opt/deno/bin:$PATH && cd /app/repo && deno task dev",
      ),
    ).toBe(true);
    expect(isDenoTaskCommand("deno task start")).toBe(true);
  });

  test("any other runtime's task", () => {
    expect(isDenoTaskCommand("cd /app/repo && bun run dev")).toBe(false);
    expect(isDenoTaskCommand("cd /app/repo && npm run dev")).toBe(false);
    expect(isDenoTaskCommand("node scripts/denotask.js")).toBe(false);
  });
});
