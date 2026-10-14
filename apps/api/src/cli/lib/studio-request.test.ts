import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session } from "./session";
import { readDataArg, studioFetch, writeResponse } from "./studio-request";

const session: Session = {
  target: "https://studio.example.com",
  clientId: "client_abc",
  user: { sub: "u_1" },
  accessToken: "at_123",
  createdAt: "2026-05-04T00:00:00.000Z",
};

function recordingFetch() {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (input: URL | string, init: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe("readDataArg", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "deco-data-arg-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns undefined when no data is given", async () => {
    expect(await readDataArg(undefined)).toBeUndefined();
  });

  it("passes a literal body through as JSON", async () => {
    expect(await readDataArg('{"a":1}')).toEqual({
      bytes: '{"a":1}',
      contentType: "application/json",
    });
  });

  it("reads @<file> as bytes typed by its extension", async () => {
    const png = join(dir, "logo.png");
    await writeFile(png, new Uint8Array([0, 255, 1]));
    const body = await readDataArg(`@${png}`);
    expect(Array.from(body!.bytes as Uint8Array)).toEqual([0, 255, 1]);
    expect(body!.contentType).toBe("image/png");

    const json = join(dir, "args.json");
    await writeFile(json, "{}");
    expect((await readDataArg(`@${json}`))!.contentType).toStartWith(
      "application/json",
    );
  });

  it("rejects a missing @<file>", async () => {
    await expect(readDataArg(`@${join(dir, "missing")}`)).rejects.toThrow();
  });

  it("reads @- from stdin as JSON", async () => {
    const bytes = new TextEncoder().encode("from stdin");
    expect(await readDataArg("@-", async () => bytes)).toEqual({
      bytes,
      contentType: "application/json",
    });
  });
});

describe("studioFetch", () => {
  it("sends the bearer token to the session's studio", async () => {
    const { calls, fetchImpl } = recordingFetch();
    await studioFetch(session, "/api/my-org/tools?x=1", {
      method: "GET",
      fetch: fetchImpl,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      "https://studio.example.com/api/my-org/tools?x=1",
    );
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get("authorization")).toBe("Bearer at_123");
    expect(headers.has("content-type")).toBe(false);
  });

  it("takes the body's content type unless the caller set one", async () => {
    const { calls, fetchImpl } = recordingFetch();
    await studioFetch(session, "/api/x", {
      method: "POST",
      body: { bytes: "{}", contentType: "application/json" },
      fetch: fetchImpl,
    });
    await studioFetch(session, "/api/x", {
      method: "PUT",
      body: { bytes: "raw", contentType: "application/json" },
      headers: new Headers({ "Content-Type": "text/plain" }),
      fetch: fetchImpl,
    });
    expect(new Headers(calls[0]!.init.headers).get("content-type")).toBe(
      "application/json",
    );
    expect(new Headers(calls[1]!.init.headers).get("content-type")).toBe(
      "text/plain",
    );
  });

  it("does not let a caller header replace the session token", async () => {
    const { calls, fetchImpl } = recordingFetch();
    await studioFetch(session, "/api/x", {
      method: "GET",
      headers: new Headers({ Authorization: "Bearer other" }),
      fetch: fetchImpl,
    });
    expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe(
      "Bearer at_123",
    );
  });

  for (const path of [
    "https://evil.example.net/steal",
    "//evil.example.net/steal",
    "/\\evil.example.net/steal",
    "api/x",
    "",
  ]) {
    it(`refuses to send the token for ${JSON.stringify(path)}`, async () => {
      const { calls, fetchImpl } = recordingFetch();
      await expect(
        studioFetch(session, path, { method: "GET", fetch: fetchImpl }),
      ).rejects.toThrow(/must start with "\/" and stay on/);
      expect(calls).toHaveLength(0);
    });
  }
});

describe("writeResponse", () => {
  let errors: string[];
  let errSpy: ReturnType<typeof spyOn>;
  beforeEach(() => {
    errors = [];
    errSpy = spyOn(console, "error").mockImplementation((msg: unknown) => {
      errors.push(String(msg));
    });
  });
  afterEach(() => {
    errSpy.mockRestore();
  });

  async function collect(res: Response) {
    const chunks: Uint8Array[] = [];
    const code = await writeResponse(res, session, async (c) => {
      chunks.push(c);
    });
    return { code, body: Buffer.concat(chunks).toString("utf8") };
  }

  it("writes the body and exits 0 on 2xx", async () => {
    const { code, body } = await collect(new Response('{"ok":true}'));
    expect(code).toBe(0);
    expect(body).toBe('{"ok":true}');
    expect(errors).toEqual([]);
  });

  it("still writes the error body and exits 1 on non-2xx", async () => {
    const { code, body } = await collect(
      new Response('{"error":"nope"}', {
        status: 404,
        statusText: "Not Found",
      }),
    );
    expect(code).toBe(1);
    expect(body).toBe('{"error":"nope"}');
    expect(errors.join("\n")).toContain("HTTP 404 Not Found");
  });

  it("hints at logging in again to the session's studio on 401", async () => {
    const { code } = await collect(new Response("", { status: 401 }));
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain(
      "decocms auth login --target https://studio.example.com",
    );
  });

  it("handles an empty body", async () => {
    const { code, body } = await collect(new Response(null, { status: 204 }));
    expect(code).toBe(0);
    expect(body).toBe("");
  });
});
