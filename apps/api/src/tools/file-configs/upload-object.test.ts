import { describe, expect, test } from "bun:test";
import { UploadRejected } from "../../file-storage/upload-policy";
import { fetchSource, filenameFor, MAX_SOURCE_BYTES } from "./upload-object";

const allow = async () => null;

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

describe("filenameFor", () => {
  test("keeps an existing extension", () => {
    expect(filenameFor("hero-desk.png", "image/jpeg")).toBe("hero-desk.png");
  });

  test("adds one from the content type", () => {
    expect(filenameFor("hero-desk", "image/jpeg")).toBe("hero-desk.jpg");
    expect(filenameFor("logo", "image/svg+xml")).toBe("logo.svg");
  });
});
