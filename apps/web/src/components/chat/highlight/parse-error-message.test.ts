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

  test("passes through a plain, short error message unchanged", () => {
    const result = parseErrorMessage("Something broke");
    expect(result.summary).toBe("Something broke");
    expect(result.rawDetails).toBeNull();
  });
});

describe("JSON envelopes", () => {
  test("renders the sentence, not the blob, and keeps the blob as detail", () => {
    const raw =
      '{"error":"No model available for tier \\"smart\\". Connect a provider or configure the tier in organization settings."}';
    const { summary, rawDetails } = parseErrorMessage(raw);
    expect(summary).toBe(
      'No model available for tier "smart". Connect a provider or configure the tier in organization settings.',
    );
    expect(rawDetails).toBe(raw);
  });

  test("still classifies the unwrapped sentence", () => {
    const { summary } = parseErrorMessage('{"error":"request timed out"}');
    expect(summary).toBe("That took longer than expected. Try again.");
  });

  test("leaves a non-envelope body to the existing rules", () => {
    expect(parseErrorMessage("plain failure").summary).toBe("plain failure");
    expect(parseErrorMessage("{not json").summary).toBe("{not json");
    expect(parseErrorMessage('{"code":"x"}').summary).toBe('{"code":"x"}');
  });
});
