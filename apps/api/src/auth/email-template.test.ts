import { describe, expect, test } from "bun:test";
import { escapeHtml } from "./email-template";

describe("escapeHtml", () => {
  test("neutralizes HTML-significant characters from untrusted input", () => {
    const malicious = `</strong><img src=x onerror=alert(1)>&"'`;
    const escaped = escapeHtml(malicious);

    expect(escaped).not.toContain("<");
    expect(escaped).not.toContain(">");
    expect(escaped).toBe(
      "&lt;/strong&gt;&lt;img src=x onerror=alert(1)&gt;&amp;&quot;&#39;",
    );
  });

  test("leaves plain text unchanged", () => {
    expect(escapeHtml("Jane Doe")).toBe("Jane Doe");
  });
});
