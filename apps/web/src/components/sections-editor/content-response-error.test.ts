import { describe, expect, it } from "bun:test";
import {
  ContentResponseError,
  contentReadRetryDelay,
} from "./content-response-error";

const NOW = Date.UTC(2026, 0, 1);

describe("content rate-limit retry delay", () => {
  it("waits for the provider's full deadline instead of the five-second backoff cap", () => {
    const error = new ContentResponseError("Rate limited", 429, "1800", NOW);
    expect(contentReadRetryDelay(1, error, NOW)).toBe(1_800_000);
    expect(contentReadRetryDelay(1, error, NOW + 20_000)).toBe(1_780_000);
  });

  it("supports an HTTP-date Retry-After", () => {
    const error = new ContentResponseError(
      "Rate limited",
      429,
      new Date(NOW + 120_000).toUTCString(),
      NOW,
    );
    expect(contentReadRetryDelay(0, error, NOW)).toBe(120_000);
  });

  it.each([
    null,
    "",
    "invalid",
    "Wed, invalid",
    "-1",
    "Infinity",
    "1e100",
    "2147484",
  ])("waits a minute when Retry-After is absent or invalid: %s", (header) => {
    const error = new ContentResponseError("Rate limited", 429, header, NOW);
    expect(contentReadRetryDelay(0, error, NOW)).toBe(60_000);
  });

  it("keeps normal backoff after the provider deadline has passed", () => {
    const error = new ContentResponseError("Rate limited", 429, "0", NOW);
    expect(contentReadRetryDelay(2, error, NOW)).toBe(4000);
  });

  it("does not apply rate-limit waiting to permission or server failures", () => {
    for (const status of [403, 404, 500, 502]) {
      const error = new ContentResponseError("Failure", status, "1800", NOW);
      expect(error.status).toBe(status);
      expect(contentReadRetryDelay(1, error, NOW)).toBe(2000);
    }
    expect(contentReadRetryDelay(4, new Error("offline"), NOW)).toBe(5000);
  });
});
