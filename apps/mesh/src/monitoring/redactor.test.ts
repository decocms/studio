import { describe, expect, it } from "bun:test";
import { RegexRedactor } from "./redactor";

const r = new RegexRedactor();

describe("RegexRedactor.redactString (single-pass)", () => {
  it("redacts each PII type with its label", () => {
    expect(r.redactString("ping user@example.com ok")).toBe(
      "ping [REDACTED:email] ok",
    );
    expect(r.redactString("token=abcdef0123456789ABCDEF")).toContain(
      "[REDACTED:api_key]",
    );
    expect(
      r.redactString(
        "tok eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123",
      ),
    ).toContain("[REDACTED:jwt]");
    expect(r.redactString("card 4111 1111 1111 1111 end")).toBe(
      "card [REDACTED:credit_card] end",
    );
    expect(r.redactString("ssn 123-45-6789 end")).toBe(
      "ssn [REDACTED:ssn] end",
    );
  });

  it("redacts multiple distinct hits in one string", () => {
    const out = r.redactString("a@b.co and 123-45-6789");
    expect(out).toBe("[REDACTED:email] and [REDACTED:ssn]");
  });

  it("leaves clean text untouched", () => {
    expect(r.redactString("nothing sensitive here")).toBe(
      "nothing sensitive here",
    );
  });

  it("redacts PII inside nested objects and keys via redact()", () => {
    const out = r.redact({ "owner@x.io": { note: "ping me@y.io" } });
    expect(JSON.stringify(out)).not.toContain("@");
    expect(JSON.stringify(out)).toContain("[REDACTED:email]");
  });
});
