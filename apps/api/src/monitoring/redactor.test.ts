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

  it("still redacts an over-long local part", () => {
    expect(r.redactString(`${"z".repeat(70)}@example.com`)).toBe(
      "[REDACTED:email]",
    );
  });

  it("stays linear on a long run of email-charset characters", () => {
    // The email alternative used to restart at every offset inside a run of
    // local-part characters, making a 64KB emit O(n^2) (~3s locally, timing
    // out CI) on the synchronous monitoring path. Doubling the input must
    // roughly double the cost, not quadruple it.
    // Best of three, so a scheduling hiccup on a loaded runner can't fail it.
    const measure = (n: number) => {
      const input = JSON.stringify({ query: "y".repeat(n) });
      let best = Infinity;
      for (let i = 0; i < 3; i++) {
        const start = performance.now();
        r.redactString(input);
        best = Math.min(best, performance.now() - start);
      }
      return best;
    };

    measure(4_000); // warm up the regex engine
    const small = measure(16_000);
    const large = measure(64_000);

    expect(large).toBeLessThan(Math.max(small * 8, 250));
  });

  it("redacts PII inside nested objects and keys via redact()", () => {
    const out = r.redact({ "owner@x.io": { note: "ping me@y.io" } });
    expect(JSON.stringify(out)).not.toContain("@");
    expect(JSON.stringify(out)).toContain("[REDACTED:email]");
  });
});
