#!/usr/bin/env node
// e2e-stub/stub-daemon.mjs
//
// Minimal, dependency-free Node implementation of the daemon.e2e.helpers.ts
// startup contract. It exists
// to prove out the DAEMON_E2E_CMD swap seam — that an *external, non-TS
// binary* can be spawned, health-polled, driven over HTTP/SSE, and torn down
// by the existing bun:test suite — not to reimplement the daemon. Only a
// couple of mutating routes (write/read) are implemented for real; every
// other `/_sandbox/*` route is auth-gated but returns 404. The CI allowlist
// pins the resulting intentional pass/fail set.
//
// Deliberately zero deps: runs directly via `node stub-daemon.mjs`.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { dirname, join, normalize, sep } from "node:path";

const PORT = Number(process.env.PROXY_PORT ?? process.env.DAEMON_PORT ?? 9000);
const TOKEN = process.env.DAEMON_TOKEN ?? "";
const BOOT_ID = process.env.DAEMON_BOOT_ID ?? "";
const APP_ROOT = process.env.APP_ROOT ?? process.env.WORKDIR ?? "/tmp";
const REPO_DIR = normalize(join(APP_ROOT, "repo"));
mkdirSync(REPO_DIR, { recursive: true });

// The only GET routes the real daemon serves without a bearer token.
const NO_AUTH_GET = new Set(["/_sandbox/idle", "/_sandbox/scripts"]);

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    ...headers,
  });
  res.end(JSON.stringify(body));
}

function checkAuth(req) {
  const header = req.headers.authorization ?? "";
  if (!header.startsWith("Bearer ")) return false;
  const provided = header.slice("Bearer ".length);
  return TOKEN.length > 0 && provided === TOKEN;
}

function repoPath(relative) {
  const target = normalize(join(REPO_DIR, String(relative)));
  if (target !== REPO_DIR && !target.startsWith(REPO_DIR + sep)) {
    throw new Error("path escapes root");
  }
  return target;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
  // Dual-serve compat: the real daemon serves both prefixes identically.
  const path = u.pathname.replace(/^\/_decopilot_vm\//, "/_sandbox/");
  const { method } = req;

  if (method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
    });
    return res.end();
  }

  if (method === "GET" && u.pathname === "/health") {
    return send(res, 200, {
      ready: true,
      bootId: BOOT_ID,
      configured: false,
      orchestrator: { running: false, pending: 0 },
      setup: { running: false, done: true },
    });
  }

  if (method === "GET" && NO_AUTH_GET.has(path)) {
    return send(
      res,
      200,
      path === "/_sandbox/scripts" ? { scripts: [] } : { idle: true },
    );
  }

  if (!path.startsWith("/_sandbox/")) {
    return send(res, 404, { error: `Not found: ${method} ${u.pathname}` });
  }

  // Every other /_sandbox/* route (including GET /_sandbox/events) requires
  // the shared bearer token — this is the whole auth story the stub proves.
  if (!checkAuth(req)) return send(res, 401, { error: "unauthorized" });

  if (method === "GET" && path === "/_sandbox/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Access-Control-Allow-Origin": "*",
      "X-Accel-Buffering": "no",
      Connection: "keep-alive",
    });
    res.write(
      `event: status\ndata: ${JSON.stringify({ bootId: BOOT_ID })}\n\n`,
    );
    req.on("close", () => res.end());
    return;
  }

  const raw = method === "GET" || method === "HEAD" ? "" : await readBody(req);
  let payload;
  if (raw) {
    try {
      payload = JSON.parse(raw);
    } catch {
      return send(res, 400, { error: "Failed to parse body: invalid JSON" });
    }
  }

  if (method === "POST" && path === "/_sandbox/write") {
    if (!payload || typeof payload.path !== "string") {
      return send(res, 400, { error: "path is required" });
    }
    try {
      const target = repoPath(payload.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, payload.content ?? "");
      return send(res, 200, { ok: true });
    } catch (e) {
      return send(res, 400, { error: String(e?.message ?? e) });
    }
  }

  if (method === "POST" && path === "/_sandbox/read") {
    if (!payload || typeof payload.path !== "string") {
      return send(res, 400, { error: "path is required" });
    }
    try {
      const target = repoPath(payload.path);
      if (!existsSync(target)) return send(res, 404, { error: "not found" });
      const lines = readFileSync(target, "utf8").split("\n");
      const content = lines.map((l, i) => `${i + 1}\t${l}`).join("\n");
      return send(res, 200, { kind: "text", content, lineCount: lines.length });
    } catch (e) {
      return send(res, 400, { error: String(e?.message ?? e) });
    }
  }

  // Authenticated but unimplemented — the expected shape for the rest of the
  // route surface in this stub (see README).
  return send(res, 404, { error: `Not found: ${method} ${u.pathname}` });
});

server.listen(PORT, "127.0.0.1", () => {
  process.stderr.write(
    `[stub-daemon] listening on 127.0.0.1:${PORT} boot=${BOOT_ID}\n`,
  );
});
