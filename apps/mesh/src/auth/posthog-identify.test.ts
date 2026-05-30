import { describe, expect, it } from "bun:test";
import { buildIdentifyPayload } from "./posthog-identify";

describe("buildIdentifyPayload", () => {
  const now = new Date("2026-04-28T12:00:00.000Z");

  it("sets email, name, and email_verified via $set", () => {
    const payload = buildIdentifyPayload(
      {
        id: "user_123",
        email: "alice@acme.com",
        name: "Alice",
        emailVerified: true,
      },
      now,
    );

    expect(payload.distinctId).toBe("user_123");
    expect(payload.properties.$set).toEqual({
      email: "alice@acme.com",
      name: "Alice",
      email_verified: true,
    });
  });

  it("sets first_seen_at and signup_email_domain via $set_once", () => {
    const payload = buildIdentifyPayload(
      {
        id: "user_123",
        email: "alice@acme.com",
        name: "Alice",
        emailVerified: true,
      },
      now,
    );

    expect(payload.properties.$set_once).toEqual({
      first_seen_at: "2026-04-28T12:00:00.000Z",
      signup_email_domain: "acme.com",
    });
  });

  it("forwards email_verified: false unchanged", () => {
    const payload = buildIdentifyPayload(
      {
        id: "user_456",
        email: "bob@example.com",
        name: "Bob",
        emailVerified: false,
      },
      now,
    );

    expect(payload.properties.$set.email_verified).toBe(false);
  });

  it("normalizes the email domain to lowercase", () => {
    const payload = buildIdentifyPayload(
      {
        id: "user_789",
        email: "CHARLIE@WIDGETS.IO",
        name: null,
        emailVerified: true,
      },
      now,
    );

    expect(payload.properties.$set_once.signup_email_domain).toBe("widgets.io");
  });

  it("sets name to null when user has no name", () => {
    const payload = buildIdentifyPayload(
      {
        id: "user_789",
        email: "charlie@widgets.io",
        name: null,
        emailVerified: true,
      },
      now,
    );

    expect(payload.properties.$set.name).toBeNull();
  });

  it("sets signup_email_domain to null when email has no @ separator", () => {
    const payload = buildIdentifyPayload(
      {
        id: "user_999",
        email: "malformed-email",
        name: "Dave",
        emailVerified: false,
      },
      now,
    );

    expect(payload.properties.$set_once.signup_email_domain).toBeNull();
  });
});
