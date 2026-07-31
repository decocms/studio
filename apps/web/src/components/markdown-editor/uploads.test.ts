import { describe, expect, it } from "bun:test";
import { isEditorFileUrl } from "./uploads";

describe("isEditorFileUrl", () => {
  it("matches an attachment this editor uploaded", () => {
    expect(
      isEditorFileUrl("/api/acme/fs/uploads/read?path=editor-files%2Fspec.pdf"),
    ).toBe(true);
  });

  it("rejects an image upload — those render as a preview, not a chip", () => {
    expect(
      isEditorFileUrl("/api/acme/fs/uploads/read?path=editor-images%2Fa.png"),
    ).toBe(false);
  });

  it("rejects other org-filesystem files, so the Library isn't a chip factory", () => {
    expect(
      isEditorFileUrl("/api/acme/fs/uploads/read?path=reports%2Fq3.pdf"),
    ).toBe(false);
    expect(
      isEditorFileUrl("/api/acme/fs/home/read?path=editor-files%2Fa.pdf"),
    ).toBe(false);
  });

  it("rejects a link the user typed, however close it looks", () => {
    expect(isEditorFileUrl("https://example.com/spec.pdf")).toBe(false);
    expect(
      isEditorFileUrl(
        "https://evil.example.com/api/acme/fs/uploads/read?path=editor-files/x.pdf",
      ),
      // Absolute, cross-origin: the path matches but the bytes aren't ours.
    ).toBe(false);
    expect(isEditorFileUrl("not a url at all")).toBe(false);
    expect(isEditorFileUrl("")).toBe(false);
  });
});
