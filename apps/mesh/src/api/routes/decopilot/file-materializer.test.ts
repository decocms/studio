import { describe, expect, it } from "bun:test";
import { messageHasAttachmentAnnotation } from "./file-materializer";

const msg = (text: string) =>
  ({ id: "m", role: "user", parts: [{ type: "text", text }] }) as never;

describe("messageHasAttachmentAnnotation", () => {
  it("detects the sandbox-attachment annotation", () => {
    expect(
      messageHasAttachmentAnnotation(
        msg(
          "[Attached files — already inside your sandbox]\n- a.png: org/upload/a.png",
        ),
      ),
    ).toBe(true);
  });
  it("detects the uploaded-files annotation", () => {
    expect(
      messageHasAttachmentAnnotation(
        msg(
          "[Uploaded files — use these URLs when calling tools]\n- a.png: mesh-storage:k",
        ),
      ),
    ).toBe(true);
  });
  it("returns false for ordinary text", () => {
    expect(messageHasAttachmentAnnotation(msg("hello world"))).toBe(false);
  });
  it("returns false when there are no text parts", () => {
    expect(
      messageHasAttachmentAnnotation({
        id: "m",
        role: "user",
        parts: [{ type: "file", url: "mesh-storage:k" }],
      } as never),
    ).toBe(false);
  });
});
