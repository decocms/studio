import { expect, test } from "bun:test";
import { buildPrReadyEmail } from "./pr-ready-email";

const base = {
  title: "Search does not filter results",
  orgSlug: "decocms",
  keySeq: 7,
  baseUrl: "https://studio.example",
};

test("names the task and links every repository's PR", () => {
  const { subject, html } = buildPrReadyEmail({
    ...base,
    prs: [
      {
        url: "https://github.com/example/web/pull/1",
        repo: "example/web",
        number: 1,
      },
      {
        url: "https://github.com/example/api/pull/2",
        repo: "example/api",
        number: 2,
      },
    ],
  });
  expect(subject).toBe("DECO-07 is ready for your review");
  expect(html).toContain("https://studio.example/decocms/t/DECO-07");
  expect(html).toContain("https://github.com/example/web/pull/1");
  expect(html).toContain("https://github.com/example/api/pull/2");
});

test("escapes the title instead of rendering it", () => {
  const { html } = buildPrReadyEmail({
    ...base,
    title: "<script>alert(1)</script>",
    prs: [
      {
        url: "https://github.com/example/web/pull/1",
        repo: "example/web",
        number: 1,
      },
    ],
  });
  expect(html).not.toContain("<script>");
});
