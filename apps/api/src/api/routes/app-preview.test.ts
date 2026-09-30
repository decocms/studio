/**
 * HTTP layer of the phone preview routes: gates, owner-only, claim, device
 * auth, ETag/304 and body limits. The repository side is the injected
 * `backend` boundary; the storage is a small in-memory stand-in whose SQL
 * twin is covered by `storage/app-preview-sessions.integration.test.ts`.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { StudioContext } from "@/core/studio-context";
import {
  type AppPreviewSession,
  MAX_ACTIVE_DEVICES,
  mergeOverlay,
  newDeviceToken,
  newPairingCode,
  OverlayTooLargeError,
  type OverlayPatch,
  PAIRING_TTL_MS,
  type PreviewOwner,
  SESSION_TTL_MS,
  sha256Hex,
} from "@/storage/app-preview-sessions";
import {
  type AppPreviewBackend,
  appPreviewSubject,
  createAppPreviewRoutes,
  parseOverlayPatch,
  previewLinkFor,
} from "./app-preview";

interface Row extends AppPreviewSession {
  codeHash: string | null;
}

function memoryStorage() {
  const sessions = new Map<string, Row>();
  const devices = new Map<
    string,
    { id: string; sessionId: string; revoked: boolean }
  >();
  const owns = (r: Row, o: PreviewOwner) =>
    r.organizationId === o.organizationId &&
    r.virtualMcpId === o.virtualMcpId &&
    r.userId === o.userId;
  const active = (r: Row, now: Date) =>
    !r.revokedAt && new Date(r.expiresAt) > now;
  let n = 0;
  return {
    sessions,
    async create(
      o: PreviewOwner & { branch: string; pairingCode: string },
      now: Date,
    ) {
      const row: Row = {
        ...o,
        id: `aps_00000000-0000-0000-0000-${String(++n).padStart(12, "0")}`,
        overlay: { set: {}, delete: [] },
        rev: 0,
        codeHash: sha256Hex(o.pairingCode),
        pairingExpiresAt: new Date(
          now.getTime() + PAIRING_TTL_MS,
        ).toISOString(),
        expiresAt: new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
        revokedAt: null,
      };
      sessions.set(row.id, row);
      return row;
    },
    async rotatePairing(id: string, o: PreviewOwner, code: string, now: Date) {
      const r = sessions.get(id);
      if (!r || !owns(r, o) || !active(r, now)) return null;
      r.codeHash = sha256Hex(code);
      r.pairingExpiresAt = new Date(
        now.getTime() + PAIRING_TTL_MS,
      ).toISOString();
      return r;
    },
    async getForOwner(id: string, o: PreviewOwner) {
      const r = sessions.get(id);
      if (!r || !owns(r, o)) return null;
      const list = [...devices.values()]
        .filter((d) => d.sessionId === id && !d.revoked)
        .map((d) => ({ id: d.id, createdAt: "t", lastSeenAt: "t" }));
      return { session: r, devices: list };
    },
    async patchOverlay(
      id: string,
      o: PreviewOwner,
      patch: OverlayPatch,
      now: Date,
    ) {
      const r = sessions.get(id);
      if (!r || !owns(r, o) || !active(r, now)) return null;
      const merged = mergeOverlay(r.overlay, patch);
      if (JSON.stringify(merged).length > 2_000_000)
        throw new OverlayTooLargeError();
      r.overlay = merged;
      return { rev: ++r.rev };
    },
    async revoke(id: string, o: PreviewOwner, now: Date) {
      const r = sessions.get(id);
      if (!r || !owns(r, o)) return false;
      r.revokedAt ??= now.toISOString();
      r.codeHash = null;
      return true;
    },
    async claim(code: string, orgId: string, token: string, now: Date) {
      const r = [...sessions.values()].find(
        (s) => s.codeHash === sha256Hex(code),
      );
      if (
        !r ||
        r.organizationId !== orgId ||
        !active(r, now) ||
        new Date(r.pairingExpiresAt!) <= now
      ) {
        return null;
      }
      r.codeHash = null;
      r.pairingExpiresAt = null;
      const live = [...devices.values()].filter(
        (d) => d.sessionId === r.id && !d.revoked,
      );
      if (live.length >= MAX_ACTIVE_DEVICES) return null;
      devices.set(sha256Hex(token), {
        id: `apd_${devices.size}`,
        sessionId: r.id,
        revoked: false,
      });
      return r;
    },
    async authenticateDevice(token: string, orgId: string, now: Date) {
      const d = devices.get(sha256Hex(token));
      const r = d && sessions.get(d.sessionId);
      if (
        !d ||
        !r ||
        d.revoked ||
        r.organizationId !== orgId ||
        !active(r, now)
      )
        return null;
      return { session: r, deviceId: d.id };
    },
    async revokeDevice(deviceId: string) {
      for (const d of devices.values()) if (d.id === deviceId) d.revoked = true;
    },
  };
}

const gates = { open: true };
const heads = { calls: 0, sha: "sha1" };
const backend: AppPreviewBackend = {
  allowed: async (_ctx, org, vmcp) =>
    gates.open && org === "org_1" && vmcp === "vir_1",
  open: async (_ctx, org, vmcp) =>
    gates.open && org === "org_1" && vmcp === "vir_1"
      ? {
          defaultHead: async () => "default-sha",
          branchHead: async (b) => {
            heads.calls++;
            return b === "main" ? heads.sha : null;
          },
          previewLink: async () => "nb://preview?code={code}",
          decofileAt: async (sha) => JSON.stringify({ at: sha }),
        }
      : null,
};

let storage: ReturnType<typeof memoryStorage>;
let clock: { now: number };
let notified: string[];
let user: string | null;

function buildApp() {
  const app = new Hono<{ Variables: { studioContext: StudioContext } }>();
  app.use("*", async (c, next) => {
    c.set("studioContext", {
      organization: { id: "org_1", slug: "acme", name: "Acme" },
      auth: user ? { user: { id: user } } : {},
      storage: { appPreviewSessions: storage },
    } as unknown as StudioContext);
    await next();
  });
  app.route(
    "/app-preview",
    createAppPreviewRoutes({
      backend,
      now: () => clock.now,
      notify: (id) => notified.push(id),
      events: { pingMs: 30, maxMs: 60_000 },
    }),
  );
  return app;
}

const json = (
  method: string,
  body: unknown,
  headers: Record<string, string> = {},
) => ({
  method,
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});

beforeEach(() => {
  storage = memoryStorage();
  clock = { now: Date.parse("2026-01-01T00:00:00Z") };
  notified = [];
  user = "user_1";
  gates.open = true;
  heads.calls = 0;
  heads.sha = "sha1";
});

async function createSession(app = buildApp()) {
  const res = await app.request(
    "/app-preview/vir_1/sessions",
    json("POST", { branch: "main" }),
  );
  expect(res.status).toBe(201);
  return (await res.json()) as {
    id: string;
    pairingCode: string;
    link: string | null;
    expiresAt: string;
    pairingExpiresAt: string;
  };
}

async function pair(app = buildApp()) {
  const s = await createSession(app);
  user = null;
  const res = await app.request(
    "/app-preview/claim",
    json("POST", { code: s.pairingCode }),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { token: string };
  return {
    session: s,
    token: body.token,
    auth: { authorization: `DecoPreview ${body.token}` },
  };
}

describe("pure helpers", () => {
  test("merge semantics", () => {
    const base = { set: { a: { v: 1 } }, delete: ["b"] };
    expect(mergeOverlay(base, { set: { b: { v: 2 } } })).toEqual({
      set: { a: { v: 1 }, b: { v: 2 } },
      delete: [],
    });
    expect(mergeOverlay(base, { delete: ["a"] })).toEqual({
      set: {},
      delete: ["b", "a"],
    });
    expect(mergeOverlay(base, { reset: true, set: { c: {} } })).toEqual({
      set: { c: {} },
      delete: [],
    });
    const proto = mergeOverlay(
      { set: {}, delete: [] },
      JSON.parse('{"set":{"__proto__":{"x":1}}}'),
    );
    expect(Object.getPrototypeOf(proto.set)).toBe(Object.prototype);
  });

  test("code and token formats", () => {
    expect(newPairingCode()).toMatch(/^[0-9a-f]{32}$/);
    expect(newDeviceToken()).toMatch(/^dpv_[A-Za-z0-9_-]{43}$/);
    expect(newPairingCode()).not.toBe(newPairingCode());
  });

  test("link templating", () => {
    expect(previewLinkFor("nb://p?c={code}&again={code}", "ab")).toBe(
      "nb://p?c=ab&again=ab",
    );
    expect(previewLinkFor(null, "ab")).toBeNull();
  });

  test("overlay patch parsing", () => {
    expect(parseOverlayPatch({ reset: true })).toEqual({
      ok: true,
      patch: { reset: true },
    });
    expect(parseOverlayPatch({}).ok).toBe(false);
    expect(parseOverlayPatch({ reset: false }).ok).toBe(false);
    expect(parseOverlayPatch({ set: { a: [] } }).ok).toBe(false);
    expect(parseOverlayPatch({ set: { a: {} }, delete: ["a"] }).ok).toBe(false);
    const secret = {
      __resolveType: "website/loaders/secret.ts",
      encrypted: "plain text",
    };
    expect(parseOverlayPatch({ set: { a: secret } }).ok).toBe(false);
  });
});

describe("editor endpoints", () => {
  test("create returns the doc shape with a templated link", async () => {
    const s = await createSession();
    expect(Object.keys(s).sort()).toEqual(
      [
        "branch",
        "expiresAt",
        "id",
        "link",
        "pairingCode",
        "pairingExpiresAt",
      ].sort(),
    );
    expect(s.link).toBe(`nb://preview?code=${s.pairingCode}`);
    expect(Date.parse(s.pairingExpiresAt) - clock.now).toBe(10 * 60 * 1000);
    expect(Date.parse(s.expiresAt) - clock.now).toBe(2 * 60 * 60 * 1000);
  });

  test("anonymous → 401; closed gate, bad branch, other project → 404/400", async () => {
    const app = buildApp();
    user = null;
    let res = await app.request(
      "/app-preview/vir_1/sessions",
      json("POST", { branch: "main" }),
    );
    expect(res.status).toBe(401);
    user = "user_1";
    res = await app.request(
      "/app-preview/vir_1/sessions",
      json("POST", { branch: "../x" }),
    );
    expect(res.status).toBe(400);
    res = await app.request(
      "/app-preview/vir_2/sessions",
      json("POST", { branch: "main" }),
    );
    expect(res.status).toBe(404);
    gates.open = false;
    res = await app.request(
      "/app-preview/vir_1/sessions",
      json("POST", { branch: "main" }),
    );
    expect(res.status).toBe(404);
  });

  test("owner-only: another user gets 404 everywhere", async () => {
    const app = buildApp();
    const s = await createSession(app);
    user = "user_2";
    const base = `/app-preview/vir_1/sessions/${s.id}`;
    expect((await app.request(base)).status).toBe(404);
    expect(
      (await app.request(`${base}/pairing`, { method: "POST" })).status,
    ).toBe(404);
    expect(
      (await app.request(`${base}/overlay`, json("PATCH", { reset: true })))
        .status,
    ).toBe(404);
    expect((await app.request(base, { method: "DELETE" })).status).toBe(404);
  });

  test("overlay PATCH bumps rev, notifies, and enforces limits", async () => {
    const app = buildApp();
    const s = await createSession(app);
    const url = `/app-preview/vir_1/sessions/${s.id}/overlay`;
    let res = await app.request(
      url,
      json("PATCH", { set: { "pages-home": { sections: [] } } }),
    );
    expect(await res.json()).toEqual({ rev: 1 });
    expect(notified).toEqual([s.id]);

    res = await app.request(
      url,
      json("PATCH", { set: { big: { x: "y".repeat(1024 * 1024) } } }),
    );
    expect(res.status).toBe(400);
    res = await app.request(url, json("PATCH", { set: { "a/../b": {} } }));
    expect(res.status).toBe(400);
    res = await app.request(
      url,
      json("PATCH", { set: { a: "not an object" } }),
    );
    expect(res.status).toBe(400);
    res = await app.request(url, json("PATCH", { hello: 1 }));
    expect(res.status).toBe(400);

    for (let i = 0; i < 2; i++) {
      res = await app.request(
        url,
        json("PATCH", { set: { [`b${i}`]: { x: "y".repeat(900_000) } } }),
      );
    }
    res = await app.request(
      url,
      json("PATCH", { set: { b9: { x: "y".repeat(900_000) } } }),
    );
    expect(res.status).toBe(413);

    res = await app.request(url, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "content-length": String(9 * 1024 * 1024),
      },
      body: "x".repeat(9 * 1024 * 1024),
    });
    expect(res.status).toBe(413);
  });

  test("GET session and DELETE", async () => {
    const app = buildApp();
    const { session } = await pair(app);
    user = "user_1";
    const url = `/app-preview/vir_1/sessions/${session.id}`;
    const got = (await (await app.request(url)).json()) as {
      devices: unknown[];
      revokedAt: null;
    };
    expect(got.devices).toHaveLength(1);
    expect(got.revokedAt).toBeNull();
    expect((await app.request(url, { method: "DELETE" })).status).toBe(204);
    expect(notified).toContain(session.id);
    expect(
      (await app.request(`${url}/overlay`, json("PATCH", { reset: true })))
        .status,
    ).toBe(404);
  });
});

describe("device endpoints", () => {
  test("claim is single use, generic 404 on any failure", async () => {
    const app = buildApp();
    const s = await createSession(app);
    user = null;
    const claim = (code: unknown) =>
      app.request("/app-preview/claim", json("POST", { code }));
    expect((await claim("NOT-HEX")).status).toBe(404);
    expect((await claim("0".repeat(32))).status).toBe(404);
    const ok = await claim(s.pairingCode);
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as Record<string, string>;
    expect(body.token).toMatch(/^dpv_/);
    expect(body).toMatchObject({
      virtualMcpId: "vir_1",
      branch: "main",
      expiresAt: s.expiresAt,
    });
    const again = await claim(s.pairingCode);
    expect(again.status).toBe(404);
    expect(await again.json()).toEqual({ error: "Not found" });
  });

  test("an expired pairing code cannot be claimed", async () => {
    const app = buildApp();
    const s = await createSession(app);
    user = null;
    clock.now += 10 * 60 * 1000 + 1;
    const res = await app.request(
      "/app-preview/claim",
      json("POST", { code: s.pairingCode }),
    );
    expect(res.status).toBe(404);
  });

  test("claim is rate limited per IP", async () => {
    const app = buildApp();
    const headers = { "cf-connecting-ip": "203.0.113.9" };
    for (let i = 0; i < 10; i++) {
      const res = await app.request(
        "/app-preview/claim",
        json("POST", { code: "0".repeat(32) }, headers),
      );
      expect(res.status).toBe(404);
    }
    const res = await app.request(
      "/app-preview/claim",
      json("POST", { code: "0".repeat(32) }, headers),
    );
    expect(res.status).toBe(429);
  });

  test("state with ETag/304, base, and 401 cases", async () => {
    const app = buildApp();
    const { auth, session } = await pair(app);

    const res = await app.request("/app-preview/device/state", {
      headers: auth,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBe('"sha1.0"');
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      virtualMcpId: "vir_1",
      branch: "main",
      rev: 0,
      baseSha: "sha1",
      overlay: { set: {}, delete: [] },
      expiresAt: session.expiresAt,
    });

    const cached = await app.request("/app-preview/device/state", {
      headers: { ...auth, "if-none-match": '"sha1.0"' },
    });
    expect(cached.status).toBe(304);
    expect(heads.calls).toBe(1); // head cached for 15 s

    const base = await app.request("/app-preview/device/base", {
      headers: auth,
    });
    expect(await base.json()).toEqual({ at: "sha1" });
    expect(base.headers.get("etag")).toBe('"sha1"');
    const base304 = await app.request("/app-preview/device/base", {
      headers: { ...auth, "if-none-match": '"sha1"' },
    });
    expect(base304.status).toBe(304);

    for (const authorization of [
      "",
      "Bearer x",
      `DecoPreview ${newDeviceToken()}`,
    ]) {
      const r = await app.request("/app-preview/device/state", {
        headers: { authorization },
      });
      expect(r.status).toBe(401);
      expect(await r.json()).toEqual({ error: "Unauthorized" });
    }

    clock.now += 2 * 60 * 60 * 1000 + 1;
    expect(
      (await app.request("/app-preview/device/state", { headers: auth }))
        .status,
    ).toBe(401);
  });

  test("falls back to the default head for a missing branch", async () => {
    const app = buildApp();
    const s = await (async () => {
      const r = await app.request(
        "/app-preview/vir_1/sessions",
        json("POST", { branch: "draft/x" }),
      );
      return (await r.json()) as { pairingCode: string };
    })();
    user = null;
    const claimed = await app.request(
      "/app-preview/claim",
      json("POST", { code: s.pairingCode }),
    );
    const { token } = (await claimed.json()) as { token: string };
    const res = await app.request("/app-preview/device/state", {
      headers: { authorization: `DecoPreview ${token}` },
    });
    expect(((await res.json()) as { baseSha: string }).baseSha).toBe(
      "default-sha",
    );
  });

  test("DELETE device revokes the token; gates closing → 401", async () => {
    const app = buildApp();
    const { auth, session } = await pair(app);
    gates.open = false;
    expect(
      (await app.request("/app-preview/device/state", { headers: auth }))
        .status,
    ).toBe(401);
    gates.open = true;
    expect(
      (
        await app.request("/app-preview/device", {
          method: "DELETE",
          headers: auth,
        })
      ).status,
    ).toBe(204);
    expect(notified).toContain(session.id);
    expect(
      (await app.request("/app-preview/device/state", { headers: auth }))
        .status,
    ).toBe(401);
  });
});

/** Reads one SSE frame (up to the blank line) at a time. */
function frames(res: Response) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  return {
    async next(): Promise<string | null> {
      while (!buf.includes("\n\n")) {
        const { value, done } = await reader.read();
        if (done) return null;
        buf += decoder.decode(value, { stream: true });
      }
      const at = buf.indexOf("\n\n");
      const frame = buf.slice(0, at);
      buf = buf.slice(at + 2);
      return frame;
    },
    /** Next non-comment frame. */
    async event(): Promise<string | null> {
      for (;;) {
        const f = await this.next();
        if (f === null || !f.startsWith(":")) return f;
      }
    },
    cancel: () => reader.cancel(),
  };
}

const stateFrame = (rev: number, baseSha: string) =>
  `event: state\ndata: ${JSON.stringify({ rev, baseSha })}`;

describe("device events (SSE)", () => {
  test("subject guard", () => {
    const id = "aps_00000000-0000-0000-0000-000000000001";
    expect(appPreviewSubject(id)).toBe(`studio.app-preview.${id}`);
    for (const bad of ["", "a.b", "a*", "a>", "a b"]) {
      expect(appPreviewSubject(bad)).toBeNull();
    }
  });

  test("initial state, a state per nudge, pings, then end on revoke", async () => {
    const app = buildApp();
    const { auth, session } = await pair(app);
    const res = await app.request("/app-preview/device/events", {
      headers: auth,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    const sse = frames(res);
    expect(await sse.next()).toBe(stateFrame(0, "sha1"));

    user = "user_1";
    await app.request(
      `/app-preview/vir_1/sessions/${session.id}/overlay`,
      json("PATCH", { set: { a: {} } }),
    );
    expect(await sse.event()).toBe(stateFrame(1, "sha1"));
    expect(await sse.next()).toBe(": ping");

    await app.request(`/app-preview/vir_1/sessions/${session.id}`, {
      method: "DELETE",
    });
    expect(await sse.event()).toBe(
      `event: end\ndata: ${JSON.stringify({ reason: "revoked" })}`,
    );
    expect(await sse.next()).toBeNull();
  });

  test("the ping ends an expired session", async () => {
    const app = buildApp();
    const { auth } = await pair(app);
    const sse = frames(
      await app.request("/app-preview/device/events", { headers: auth }),
    );
    expect(await sse.next()).toBe(stateFrame(0, "sha1"));
    clock.now += SESSION_TTL_MS;
    expect(await sse.event()).toBe(
      `event: end\ndata: ${JSON.stringify({ reason: "expired" })}`,
    );
  });

  test("401 without a token; 429 past 3 streams per device", async () => {
    const app = buildApp();
    expect((await app.request("/app-preview/device/events")).status).toBe(401);
    const { auth } = await pair(app);
    const open = [];
    for (let i = 0; i < 3; i++) {
      const res = await app.request("/app-preview/device/events", {
        headers: auth,
      });
      expect(res.status).toBe(200);
      open.push(frames(res));
    }
    const over = await app.request("/app-preview/device/events", {
      headers: auth,
    });
    expect(over.status).toBe(429);

    await open[0]!.cancel();
    await new Promise((r) => setTimeout(r, 10));
    const again = await app.request("/app-preview/device/events", {
      headers: auth,
    });
    expect(again.status).toBe(200);
    for (const s of [...open.slice(1), frames(again)]) await s.cancel();
  });
});
