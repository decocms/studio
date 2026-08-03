/**
 * Unit tier: the WebDAV handler's read push-down logic over an in-memory
 * OrgFsApi (no IO). The full-chain behavior (real routes + Postgres) lives in
 * webdav.integration.test.ts; this covers the branch that can't be exercised
 * there (Dev storage presigns to data: URLs, so integration always falls back).
 */

import { describe, expect, it } from "bun:test";
import { type OrgFsApi, OrgFsApiError, type OrgFsNode } from "./api";
import { createWebdavHandler } from "./webdav";

/** Real in-memory fs; `stream` adds a readResponse that honors Range like a
 *  byte store. `streamed()` reports how many reads the push-down path served. */
function memFs(opts: { stream?: "ranges" | "null" } = {}) {
  const files = new Map<string, Uint8Array>();
  const node = (p: string): OrgFsNode => ({
    path: p,
    kind: "file",
    size: files.get(p)?.length ?? 0,
    updatedAt: new Date().toISOString(),
  });
  let streamed = 0;
  const api: OrgFsApi = {
    listDir: async () => [...files.keys()].map(node),
    stat: async (p) => (files.has(p) ? node(p) : null),
    read: async (p) => {
      const b = files.get(p);
      if (!b) throw new OrgFsApiError(404, "not found");
      return b;
    },
    write: async (p, b) => void files.set(p, b),
    mkdir: async () => {},
    remove: async (p) => void files.delete(p),
    move: async (f, t) => {
      const b = files.get(f);
      if (b) files.set(t, b);
      files.delete(f);
    },
  };
  if (opts.stream === "null") {
    api.readResponse = async () => null;
  } else if (opts.stream === "ranges") {
    api.readResponse = async (p, range) => {
      const b = files.get(p);
      if (!b) throw new OrgFsApiError(404, "not found");
      streamed++;
      const m = range ? /^bytes=(\d+)-(\d+)$/.exec(range) : null;
      if (m) {
        const start = Number(m[1]);
        if (start >= b.length) return new Response(null, { status: 416 });
        const end = Math.min(Number(m[2]), b.length - 1);
        const slice = b.subarray(start, end + 1);
        return new Response(slice as BodyInit, {
          status: 206,
          headers: {
            "content-length": String(slice.length),
            "content-range": `bytes ${start}-${end}/${b.length}`,
          },
        });
      }
      return new Response(b as BodyInit, {
        status: 200,
        headers: { "content-length": String(b.length) },
      });
    };
  }
  return { api, files, streamed: () => streamed };
}

const enc = (s: string) => new TextEncoder().encode(s);

describe("WebDAV read push-down", () => {
  it("streams a full GET through readResponse", async () => {
    const fs = memFs({ stream: "ranges" });
    fs.files.set("f.txt", enc("0123456789"));
    const dav = createWebdavHandler(fs.api);
    const res = await dav(new Request("http://dav/f.txt"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("0123456789");
    expect(res.headers.get("content-length")).toBe("10");
    expect(fs.streamed()).toBe(1);
  });

  it("forwards Range and passes 206 + content-range through", async () => {
    const fs = memFs({ stream: "ranges" });
    fs.files.set("f.txt", enc("0123456789"));
    const dav = createWebdavHandler(fs.api);
    const res = await dav(
      new Request("http://dav/f.txt", { headers: { range: "bytes=2-5" } }),
    );
    expect(res.status).toBe(206);
    expect(await res.text()).toBe("2345");
    expect(res.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(fs.streamed()).toBe(1);
  });

  it("maps an unsatisfiable upstream range to 416", async () => {
    const fs = memFs({ stream: "ranges" });
    fs.files.set("f.txt", enc("abc"));
    const dav = createWebdavHandler(fs.api);
    const res = await dav(
      new Request("http://dav/f.txt", { headers: { range: "bytes=99-100" } }),
    );
    expect(res.status).toBe(416);
  });

  it("falls back to buffered read when readResponse yields null", async () => {
    const fs = memFs({ stream: "null" });
    fs.files.set("f.txt", enc("0123456789"));
    const dav = createWebdavHandler(fs.api);
    const full = await dav(new Request("http://dav/f.txt"));
    expect(full.status).toBe(200);
    expect(await full.text()).toBe("0123456789");
    // Range is applied locally on the buffered bytes.
    const ranged = await dav(
      new Request("http://dav/f.txt", { headers: { range: "bytes=2-5" } }),
    );
    expect(ranged.status).toBe(206);
    expect(await ranged.text()).toBe("2345");
  });

  it("buffers via read() when the backend has no readResponse", async () => {
    const fs = memFs();
    fs.files.set("f.txt", enc("xyz"));
    const dav = createWebdavHandler(fs.api);
    const res = await dav(new Request("http://dav/f.txt"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("xyz");
  });

  it("404s a push-down read of a missing file", async () => {
    const fs = memFs({ stream: "ranges" });
    const dav = createWebdavHandler(fs.api);
    expect((await dav(new Request("http://dav/nope.txt"))).status).toBe(404);
  });
});
