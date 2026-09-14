import { describe, expect, it } from "bun:test";
import { validateHostname } from "./api";

describe("validateHostname", () => {
  it("returns null for valid domains", () => {
    expect(validateHostname("example.com")).toBeNull();
    expect(validateHostname("www.example.com")).toBeNull();
    expect(validateHostname("sub.domain.example.com")).toBeNull();
    expect(validateHostname("EXAMPLE.COM")).toBeNull();
    expect(validateHostname("  example.com  ")).toBeNull();
  });

  it("returns null for empty string (checked by caller)", () => {
    expect(validateHostname("")).toBeNull();
  });

  it("rejects single-label domains without TLD", () => {
    const error = validateHostname("localhost");
    expect(error).not.toBeNull();
    expect(error).toContain("TLD");
  });

  it("rejects domains with too many characters", () => {
    const longDomain = "a".repeat(250) + ".com";
    const error = validateHostname(longDomain);
    expect(error).not.toBeNull();
    expect(error).toContain("too long");
  });

  it("rejects labels that are too long", () => {
    const longLabel = "a".repeat(64);
    const error = validateHostname(`${longLabel}.com`);
    expect(error).not.toBeNull();
    expect(error).toContain("too long");
  });

  it("rejects invalid characters", () => {
    expect(validateHostname("exam ple.com")).not.toBeNull();
    expect(validateHostname("exam@ple.com")).not.toBeNull();
    expect(validateHostname("exam_ple.com")).not.toBeNull();
  });

  it("rejects labels starting or ending with hyphen", () => {
    expect(validateHostname("-example.com")).not.toBeNull();
    expect(validateHostname("example-.com")).not.toBeNull();
    expect(validateHostname("example.-com")).not.toBeNull();
  });

  it("accepts hyphens in the middle of labels", () => {
    expect(validateHostname("my-domain.com")).toBeNull();
    expect(validateHostname("my-awesome-domain.co.uk")).toBeNull();
  });

  it("accepts numbers in labels", () => {
    expect(validateHostname("example123.com")).toBeNull();
    expect(validateHostname("123example.com")).toBeNull();
  });
});
