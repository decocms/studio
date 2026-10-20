import { expect, test } from "bun:test";
import { withTaskIntake } from "./task-intake";
import type { TiptapDoc } from "./types";

test("the guide leads, and the report and its attachments follow untouched", () => {
  const report: TiptapDoc = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: "Search is broken" }],
      },
      {
        type: "file",
        attrs: { id: "screenshot", name: "image.png", data: "synthetic" },
      },
    ],
  };
  const result = withTaskIntake(report);
  expect(result.content?.slice(1)).toEqual(report.content);
  expect(JSON.stringify(result.content?.[0])).toContain("super-agent");
  expect(report.content).toHaveLength(2);
});
