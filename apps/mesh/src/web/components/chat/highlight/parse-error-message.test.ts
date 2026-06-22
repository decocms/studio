import { describe, expect, test } from "bun:test";
import { parseErrorMessage } from "./parse-error-message";

describe("parseErrorMessage", () => {
  test("surfaces sandbox bring-up failures with a specific summary, not the generic timeout text", () => {
    // Shape the daemon emits (via the `handler_error` frame) on a config timeout.
    const raw =
      "handler_error: sandbox failed to start: configuration timed out";
    const result = parseErrorMessage(raw);

    // Must NOT collapse into the generic timeout bucket even though the
    // message contains "timed out".
    expect(result.summary).not.toBe(
      "That took longer than expected. Try again.",
    );
    expect(result.summary.toLowerCase()).toContain("sandbox");
    expect(result.summary).toContain("configuration timed out");
    expect(result.rawDetails).toBe(raw);
  });

  test("uses a generic sandbox summary when no cause clause is present", () => {
    const result = parseErrorMessage("sandbox failed to start");
    expect(result.summary.toLowerCase()).toContain("sandbox");
    expect(result.summary).not.toContain("(");
    expect(result.rawDetails).toBe("sandbox failed to start");
  });

  test("still classifies a plain timeout (no sandbox marker) as the generic timeout", () => {
    const result = parseErrorMessage("handler_error: The operation timed out.");
    expect(result.summary).toBe("That took longer than expected. Try again.");
  });

  test("classifies a desktop-link-offline 409 body with a re-link CTA", () => {
    // Shape POST /messages returns when the thread is pinned to user-desktop
    // and resolveDispatchTarget finds no live link claim.
    const raw =
      '{"error":"link_unavailable","code":"user_desktop_link_offline"}';
    const result = parseErrorMessage(raw);
    expect(result.summary).toContain("desktop is offline");
    expect(result.summary).toContain("bunx decocms@latest link");
    expect(result.rawDetails).toBe(raw);
  });

  test("classifies a capability-missing 409 body with install guidance", () => {
    const raw =
      '{"error":"link_unavailable","code":"user_desktop_link_capability_missing","activeCapabilities":["decopilot-sandbox"]}';
    const result = parseErrorMessage(raw);
    expect(result.summary).toContain("wasn't detected");
    expect(result.rawDetails).toBe(raw);
  });

  test("passes through a plain, short error message unchanged", () => {
    const result = parseErrorMessage("Something broke");
    expect(result.summary).toBe("Something broke");
    expect(result.rawDetails).toBeNull();
  });
});
