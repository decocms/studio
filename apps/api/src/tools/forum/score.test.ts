import { describe, expect, it } from "bun:test";
import type { OnePager } from "@decocms/shared/reports/public-report";
import { scorableDomain, scoreReplyMarkdown } from "./score";

describe("scorableDomain", () => {
  it("normalizes what people paste", () => {
    expect(scorableDomain("https://www.Example.com.br/produto?x=1")).toBe(
      "example.com.br",
    );
  });

  it("rejects anything the engine should not fetch", () => {
    for (const raw of [
      "",
      "localhost",
      "127.0.0.1",
      "10.0.0.1",
      "example.com:8080",
      "exa mple.com",
      "-bad.com",
      `${"a".repeat(64)}.com`,
    ]) {
      expect(scorableDomain(raw)).toBeNull();
    }
  });
});

describe("scoreReplyMarkdown", () => {
  const item = (title: string, impact?: string) => ({
    check_id: title,
    title,
    impact,
    category: "perf",
    severity: "high",
    pages: [],
    tasks: [],
    evidence: "",
    sources: [],
  });
  const report: OnePager = {
    domain: "example.com",
    brand: "Example",
    scanned_at: "2026-10-17T00:00:00Z",
    lang: "en",
    score: 59,
    band: "Weak",
    totals: {
      measured: 10,
      registry_total: 20,
      passed: 6,
      failed: 4,
      blocked: 0,
    },
    buckets: [
      {
        id: "critical",
        label: "Critical",
        items: [item("LCP", "Hero is slow")],
      },
      {
        id: "important",
        label: "Important",
        items: [item("CLS"), item("Alt text"), item("Fourth")],
      },
    ],
    passing: { count: 0, items: [] },
    not_measured: { count: 0, groups: [] },
    categories: [],
    screenshots: [],
  };

  it("leads with the score, shows the card, and lists the top three fixes", () => {
    const md = scoreReplyMarkdown(report);
    expect(md.startsWith("**example.com scores 59/100** · Weak")).toBe(true);
    expect(md).toContain("/diagnostics/example.com/og.png)");
    expect(md).toContain("/report/example.com)");
    expect(md).toContain("1. **LCP**. Hero is slow");
    expect(md).toContain("3. **Alt text**.");
    expect(md).not.toContain("Fourth");
    expect(md).toContain("6 checks pass and 4 fail.");
  });
});
