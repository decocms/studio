import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { fsByteResponse } from "./fs-bytes";

function serve(path: string) {
  const app = new Hono();
  app.get("/read", (c) => fsByteResponse(c, new Uint8Array([1]), path, false));
  return app.request("/read");
}

describe("fsByteResponse", () => {
  it("names the file after the path, not the /read route", async () => {
    const res = await serve("editor-files/0b7c.docx");
    expect(res.headers.get("content-disposition")).toBe(
      "inline; filename*=UTF-8''0b7c.docx",
    );
  });

  it("encodes non-ASCII and header-breaking characters", async () => {
    const res = await serve(`docs/relatório "final" (v2)'s.pdf`);
    expect(res.headers.get("content-disposition")).toBe(
      "inline; filename*=UTF-8''relat%C3%B3rio%20%22final%22%20%28v2%29%27s.pdf",
    );
  });
});
