import { describe, expect, test } from "bun:test";
import { reportAttributionFromSearch, reportAuthErrorType } from "./track";

describe("reportAttributionFromSearch", () => {
  test("keeps share attribution and campaign fields", () => {
    expect(
      reportAttributionFromSearch(
        "?share_id=store%3Aslide%3Aabc&utm_source=share&utm_medium=deck&utm_campaign=report",
      ),
    ).toEqual({
      entrypoint: "share",
      share_id: "store:slide:abc",
      utm_source: "share",
      utm_medium: "deck",
      utm_campaign: "report",
    });
  });

  test("recognizes email links without exposing their private token", () => {
    expect(
      reportAttributionFromSearch(
        "?d=private-token&email_run_id=run-42&utm_source=email",
      ),
    ).toEqual({
      entrypoint: "email",
      email_run_id: "run-42",
      utm_source: "email",
    });
  });

  test("distinguishes campaigns from direct visits", () => {
    expect(reportAttributionFromSearch("?utm_source=partner")).toEqual({
      entrypoint: "campaign",
      utm_source: "partner",
    });
    expect(reportAttributionFromSearch("")).toEqual({
      entrypoint: "direct",
    });
  });
});

describe("reportAuthErrorType", () => {
  test.each([
    ["invalid_email", "invalid_email"],
    ["HTTP 429", "rate_limited"],
    ["Invalid OTP", "invalid_or_expired_code"],
    ["Código inválido", "invalid_or_expired_code"],
    ["Unauthorized", "invalid_credentials"],
    ["Account already exists", "account_exists"],
    ["Failed to fetch", "network"],
    ["Popup closed", "cancelled"],
    ["Unexpected response", "unknown"],
  ])("maps %s to a bounded category", (message, category) => {
    expect(reportAuthErrorType(message)).toBe(category);
  });
});
