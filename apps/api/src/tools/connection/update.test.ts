import { describe, expect, test } from "bun:test";
import { REDACTED_CONNECTION_TOKEN } from "./schema";
import {
  dropRedactedToken,
  resolveFinalConnectionUrl,
  stripImmutableUpdateFields,
} from "./update";

describe("dropRedactedToken", () => {
  test("omits the placeholder so the stored token is kept", () => {
    const data = dropRedactedToken({
      title: "Echoed back",
      connection_token: REDACTED_CONNECTION_TOKEN,
    });

    expect(data).toEqual({ title: "Echoed back" });
  });

  test("keeps an explicit null so the caller can clear the token", () => {
    expect(dropRedactedToken({ connection_token: null })).toEqual({
      connection_token: null,
    });
  });

  test("keeps a new token", () => {
    expect(dropRedactedToken({ connection_token: "new-token" })).toEqual({
      connection_token: "new-token",
    });
  });
});

describe("stripImmutableUpdateFields", () => {
  test("drops organization_id so a connection can't be reassigned to another org", () => {
    const sanitized = stripImmutableUpdateFields({
      title: "New title",
      organization_id: "org_attacker",
    });

    expect(sanitized).toEqual({ title: "New title" });
  });

  test("drops id, created_by, and created_at alongside organization_id", () => {
    const sanitized = stripImmutableUpdateFields({
      id: "conn_forged",
      organization_id: "org_attacker",
      created_by: "user_forged",
      created_at: "1970-01-01T00:00:00.000Z",
      title: "Still allowed",
    });

    expect(sanitized).toEqual({ title: "Still allowed" });
  });

  test("leaves mutable fields untouched", () => {
    const sanitized = stripImmutableUpdateFields({
      title: "New title",
      description: "New description",
    });

    expect(sanitized).toEqual({
      title: "New title",
      description: "New description",
    });
  });
});

describe("resolveFinalConnectionUrl", () => {
  test("keeps the existing URL when connection_url is omitted", () => {
    expect(
      resolveFinalConnectionUrl({ title: "New title" }, "https://old.invalid"),
    ).toBe("https://old.invalid");
  });

  test("clears the URL when the caller explicitly sends null", () => {
    expect(
      resolveFinalConnectionUrl(
        { connection_type: "STDIO", connection_url: null },
        "https://old.invalid",
      ),
    ).toBeNull();
  });

  test("applies a new URL when provided", () => {
    expect(
      resolveFinalConnectionUrl(
        { connection_url: "https://new.invalid" },
        "https://old.invalid",
      ),
    ).toBe("https://new.invalid");
  });
});
