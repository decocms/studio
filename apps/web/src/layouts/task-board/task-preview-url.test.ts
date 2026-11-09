import { expect, test } from "bun:test";
import { taskPreviewUrl } from "./task-preview-url";
const fence = (data: unknown) =>
  "```testing\n" + JSON.stringify(data) + "\n```";
const block = {
  steps: [{ action: "Click" }],
  previewUrl: "https://preview.example.com/page",
};
const prs = [{ previewUrl: "https://pr.example.com" }];
test("testing URL takes precedence over PR URL", () => {
  expect(taskPreviewUrl(fence(block), prs)).toBe(block.previewUrl);
});
test("first valid testing preview wins in document order", () => {
  expect(
    taskPreviewUrl(
      fence({ steps: block.steps }) +
        "\n\n" +
        fence(block) +
        "\n\n" +
        fence({ ...block, previewUrl: "https://later.example.com" }),
      prs,
    ),
  ).toBe(block.previewUrl);
});
test("incomplete or invalid structured blocks fall back to PR", () => {
  for (const description of [
    "```testing\n{",
    fence({ previewUrl: block.previewUrl }),
    fence({ ...block, previewUrl: "javascript:alert(1)" }),
    "No testing block",
  ])
    expect(taskPreviewUrl(description, prs)).toBe("https://pr.example.com");
});
test("skips missing and unsafe PR URLs", () => {
  expect(
    taskPreviewUrl(null, [
      { previewUrl: null },
      { previewUrl: "https://user:secret@example.com" },
      ...prs,
    ]),
  ).toBe("https://pr.example.com");
});
test("no preview remains empty", () => {
  expect(taskPreviewUrl(null, [])).toBeNull();
  expect(
    taskPreviewUrl(fence({ steps: block.steps }), [
      { previewUrl: "javascript:alert(1)" },
    ]),
  ).toBeNull();
});
