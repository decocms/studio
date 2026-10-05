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

  it("passes a literal body through", async () => {
    expect(await readDataArg('{"a":1}')).toBe('{"a":1}');
  });

  it("reads @<file> as bytes", async () => {
    const path = join(dir, "body.bin");
    await writeFile(path, new Uint8Array([0, 255, 1]));
    expect(Array.from((await readDataArg(`@${path}`)) as Uint8Array)).toEqual([
      0, 255, 1,
    ]);
  });

  it("reads @- from stdin", async () => {
    const bytes = new TextEncoder().encode("from stdin");
    expect(await readDataArg("@-", async () => bytes)).toBe(bytes);
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

  it("defaults the content type to JSON only when there is a body", async () => {
    const { calls, fetchImpl } = recordingFetch();
    await studioFetch(session, "/api/x", {
      method: "POST",
      body: "{}",
      fetch: fetchImpl,
    });
    await studioFetch(session, "/api/x", {
      method: "PUT",
      body: "raw",
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
    const code = await writeResponse(res, async (c) => {
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

  it("hints at logging in again on 401", async () => {
    const { code } = await collect(new Response("", { status: 401 }));
    expect(code).toBe(1);
    expect(errors.join("\n")).toMatch(/decocms auth login/);
  });

  it("handles an empty body", async () => {
    const { code, body } = await collect(new Response(null, { status: 204 }));
    expect(code).toBe(0);
    expect(body).toBe("");
  });
});
