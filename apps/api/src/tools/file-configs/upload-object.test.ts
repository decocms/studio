import { describe, expect, test } from "bun:test";
import { UploadRejected } from "../../file-storage/upload-policy";
import {
  decodeInline,
  fetchSource,
  filenameFor,
  MAX_INLINE_BYTES,
  MAX_SOURCE_BYTES,
} from "./upload-object";

const allow = async () => null;
const PDF = new TextEncoder().encode("%PDF-1.7\n%binary");

function respond(body: BodyInit | null, init: ResponseInit) {
  return { guard: allow, fetch: async () => new Response(body, init) };
}

describe("fetchSource", () => {
  test("returns the bytes and normalized content type", async () => {
    const src = await fetchSource(
      "https://cdn.example.com/a.jpg",
      respond(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "Image/JPEG; q=1" },
      }),
    );
    expect(src.contentType).toBe("image/jpeg");
    expect(src.bytes.byteLength).toBe(3);
  });

  test("refuses plain http", async () => {
    await expect(
      fetchSource("http://cdn.example.com/a.jpg", respond("x", {})),
    ).rejects.toBeInstanceOf(UploadRejected);
  });

  test("refuses what the private-network guard blocks", async () => {
    await expect(
      fetchSource("https://internal.example.com/a.jpg", {
        guard: async () => "URLs targeting private networks are not allowed",
        fetch: async () => {
          throw new Error("must not fetch");
        },
      }),
    ).rejects.toThrow("private networks");
  });

  test("refuses a non-2xx answer", async () => {
    await expect(
      fetchSource(
        "https://cdn.example.com/gone.jpg",
        respond(null, { status: 404 }),
      ),
    ).rejects.toThrow("HTTP 404");
  });

  test("refuses a type outside the upload allowlist", async () => {
    await expect(
      fetchSource(
        "https://cdn.example.com/page",
        respond("<html>", { headers: { "content-type": "text/html" } }),
      ),
    ).rejects.toThrow("not allowed");
  });

  test("refuses text, JSON and SVG, which the upload route would accept", async () => {
    for (const type of ["text/plain", "application/json", "image/svg+xml"]) {
      await expect(
        fetchSource(
          "https://cdn.example.com/x",
          respond("{}", { headers: { "content-type": type } }),
        ),
      ).rejects.toThrow("only images, video and PDF");
    }
  });

  test("accepts a PDF", async () => {
    const src = await fetchSource(
      "https://cdn.example.com/manual.pdf",
      respond(PDF, { headers: { "content-type": "application/pdf" } }),
    );
    expect(src.contentType).toBe("application/pdf");
    expect(src.bytes.byteLength).toBe(PDF.byteLength);
  });

  test("refuses a text answer labeled as PDF", async () => {
    await expect(
      fetchSource(
        "https://internal.example.com/status",
        respond('{"ok":true}', {
          headers: { "content-type": "application/pdf" },
        }),
      ),
    ).rejects.toThrow("%PDF- signature");
  });

  test("refuses an empty body", async () => {
    await expect(
      fetchSource(
        "https://cdn.example.com/empty.png",
        respond(new Uint8Array(0), {
          headers: { "content-type": "image/png" },
        }),
      ),
    ).rejects.toBeInstanceOf(UploadRejected);
  });

  test("refuses a body over the cap even without content-length", async () => {
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ * chunk.byteLength > MAX_SOURCE_BYTES) controller.close();
        else controller.enqueue(chunk);
      },
    });
    await expect(
      fetchSource(
        "https://cdn.example.com/huge.png",
        respond(stream, { headers: { "content-type": "image/png" } }),
      ),
    ).rejects.toThrow("too large");
  });
});

describe("decodeInline", () => {
  const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

  test("decodes a PDF", () => {
    const src = decodeInline({
      content: b64(PDF),
      contentType: "Application/PDF",
    });
    expect(src.contentType).toBe("application/pdf");
    expect(src.bytes).toEqual(PDF);
  });

  test("decodes an image", () => {
    const src = decodeInline({
      content: b64(new Uint8Array([1, 2, 3])),
      contentType: "image/png",
    });
    expect(src.bytes.byteLength).toBe(3);
  });

  test("refuses types outside the tool's allowlist", () => {
    for (const contentType of [
      "text/html",
      "image/svg+xml",
      "application/zip",
    ]) {
      expect(() => decodeInline({ content: b64(PDF), contentType })).toThrow(
        "only images, video and PDF",
      );
    }
  });

  test("refuses a PDF without the signature", () => {
    expect(() =>
      decodeInline({
        content: b64(new TextEncoder().encode("<html>")),
        contentType: "application/pdf",
      }),
    ).toThrow("%PDF- signature");
  });

  test("refuses invalid base64 and a data: prefix", () => {
    for (const content of [
      "not base64!",
      `data:application/pdf;base64,${b64(PDF)}`,
    ]) {
      expect(() =>
        decodeInline({ content, contentType: "application/pdf" }),
      ).toThrow("not valid base64");
    }
  });

  test("refuses an empty file", () => {
    expect(() =>
      decodeInline({ content: "", contentType: "image/png" }),
    ).toThrow(UploadRejected);
  });

  test("refuses a file over the inline cap", () => {
    const big = new Uint8Array(MAX_INLINE_BYTES + 1);
    big.set(PDF);
    expect(() =>
      decodeInline({ content: b64(big), contentType: "application/pdf" }),
    ).toThrow("too large");
  });
});

describe("filenameFor", () => {
  test("keeps an existing extension", () => {
    expect(filenameFor("hero-desk.png", "image/jpeg")).toBe("hero-desk.png");
  });

  test("adds one from the content type", () => {
    expect(filenameFor("hero-desk", "image/jpeg")).toBe("hero-desk.jpg");
    expect(filenameFor("logo", "image/svg+xml")).toBe("logo.svg");
    expect(filenameFor("manual", "application/pdf")).toBe("manual.pdf");
  });
});
