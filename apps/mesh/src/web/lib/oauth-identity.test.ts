import { describe, expect, it } from "bun:test";
import { applyEmailToTitle, decodeJwtEmail } from "./oauth-identity";

/** Build a JWT-shaped string with the given payload (header/sig are dummies). */
function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_");
  return `${b64({ alg: "none" })}.${b64(payload)}.sig`;
}

describe("decodeJwtEmail", () => {
  it("extracts the email claim", () => {
    expect(decodeJwtEmail(jwt({ email: "alice@acme.com" }))).toBe(
      "alice@acme.com",
    );
  });

  it("falls back to upn then preferred_username", () => {
    expect(decodeJwtEmail(jwt({ upn: "bob@corp.com" }))).toBe("bob@corp.com");
    expect(decodeJwtEmail(jwt({ preferred_username: "@carol" }))).toBe(
      "@carol",
    );
  });

  it("prefers email over the other claims", () => {
    expect(decodeJwtEmail(jwt({ email: "a@x.com", upn: "b@x.com" }))).toBe(
      "a@x.com",
    );
  });

  it("returns null when no known claim is present", () => {
    expect(decodeJwtEmail(jwt({ sub: "123" }))).toBeNull();
  });

  it("returns null for non-JWT / malformed input", () => {
    expect(decodeJwtEmail("not-a-jwt")).toBeNull();
    expect(decodeJwtEmail("a.b")).toBeNull();
    expect(decodeJwtEmail("a.!!!.c")).toBeNull();
    expect(decodeJwtEmail("")).toBeNull();
  });
});

describe("applyEmailToTitle", () => {
  it("appends the email to a bare title", () => {
    expect(applyEmailToTitle("Google Gmail", "alice@acme.com")).toBe(
      "Google Gmail (alice@acme.com)",
    );
  });

  it("replaces an existing email suffix on re-auth (no doubling)", () => {
    expect(
      applyEmailToTitle("Google Gmail (alice@acme.com)", "bob@acme.com"),
    ).toBe("Google Gmail (bob@acme.com)");
  });

  it("replaces a numeric instance suffix", () => {
    expect(applyEmailToTitle("Google Gmail (2)", "alice@acme.com")).toBe(
      "Google Gmail (alice@acme.com)",
    );
  });

  it("only strips a trailing parenthesized segment", () => {
    expect(applyEmailToTitle("My (test) Conn", "a@x.com")).toBe(
      "My (test) Conn (a@x.com)",
    );
  });

  it("collapses whitespace and caps length", () => {
    expect(applyEmailToTitle("App", "  a\n b@x.com  ")).toBe("App (a b@x.com)");
    const long = `${"x".repeat(200)}@x.com`;
    const out = applyEmailToTitle("App", long);
    // "App (" + 120 chars + ")"
    expect(out.length).toBe("App ()".length + 120);
  });

  it("returns the base title when the email sanitizes to nothing", () => {
    expect(applyEmailToTitle("Google Gmail (2)", "   ")).toBe("Google Gmail");
  });
});
