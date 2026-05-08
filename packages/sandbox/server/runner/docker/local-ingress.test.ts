import { afterEach, describe, expect, it } from "bun:test";
import * as net from "node:net";
import type { AddressInfo } from "node:net";
import type { DockerSandboxRunner } from "./runner";
import { startLocalSandboxIngress } from "./local-ingress";

// local-ingress is a raw TCP proxy (not fetch-based). Testing it end-to-end
// through real sockets is the only realistic option: the internal helpers
// (extractHandle, parseRequestHead, route) are not exported, and the interesting
// behavior — header accumulation, routing by subdomain, error response framing
// — is emergent from the socket pipeline.

type MockUpstream = {
  port: number;
  received: () => string;
  close: () => Promise<void>;
};

function startUpstream(marker: string): Promise<MockUpstream> {
  return new Promise((resolve) => {
    let received = Buffer.alloc(0);
    const server = net.createServer((sock) => {
      sock.on("data", (chunk) => {
        received = Buffer.concat([received, chunk]);
        // Respond so the ingress → client pipe can close cleanly.
        sock.end(
          `HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: ${marker.length}\r\nConnection: close\r\n\r\n${marker}`,
        );
      });
      sock.on("error", () => {});
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({
        port: addr.port,
        received: () => received.toString("utf8"),
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

type ParsedResponse = { status: number; body: string; raw: string };

function parseResponse(raw: string): ParsedResponse {
  const idx = raw.indexOf("\r\n\r\n");
  const headText = idx === -1 ? raw : raw.slice(0, idx);
  const body = idx === -1 ? "" : raw.slice(idx + 4);
  const firstLine = headText.split("\r\n")[0] ?? "";
  const m = /HTTP\/1\.1 (\d+)/.exec(firstLine);
  return { status: m ? Number(m[1]) : 0, body, raw };
}

// Resolves when the ingress has written the full response and closed its side.
// Listens to both 'end' (remote FIN) and 'close' (socket fully torn down)
// because Bun's net socket doesn't always fire 'end' for half-closed responses
// written via socket.end(data).
function driveRequest(
  port: number,
  writer: (client: net.Socket) => void,
): Promise<ParsedResponse> {
  return new Promise((resolve, reject) => {
    const client = net.connect(port, "127.0.0.1");
    let response = Buffer.alloc(0);
    let resolved = false;
    const finish = (): void => {
      if (resolved) return;
      resolved = true;
      client.destroy();
      resolve(parseResponse(response.toString("utf8")));
    };
    client.on("connect", () => writer(client));
    client.on("data", (chunk) => {
      response = Buffer.concat([response, chunk]);
    });
    client.on("end", finish);
    client.on("close", finish);
    client.on("error", reject);
  });
}

function sendHttp(
  port: number,
  host: string,
  path: string,
  method = "GET",
): Promise<ParsedResponse> {
  return driveRequest(port, (client) => {
    client.write(
      `${method} ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`,
    );
  });
}

// Sends raw bytes and waits for the ingress to respond + close. Used for
// malformed-request and oversized-header tests.
function sendRaw(port: number, bytes: string): Promise<ParsedResponse> {
  return driveRequest(port, (client) => {
    client.write(bytes);
  });
}

function runnerFor(
  map: Record<string, { dev?: number; daemon?: number }>,
): DockerSandboxRunner {
  return {
    resolveDevPort: async (h: string) => map[h]?.dev ?? null,
    resolveDaemonPort: async (h: string) => map[h]?.daemon ?? null,
  } as unknown as DockerSandboxRunner;
}

async function startIngress(
  getRunner: () => DockerSandboxRunner | null,
): Promise<{ servers: net.Server[]; port: number }> {
  // port 0 → OS picks a free port; dodges EADDRINUSE + the retry loop.
  const servers = startLocalSandboxIngress(getRunner, 0);
  await new Promise<void>((resolve, reject) => {
    const s = servers[0]!;
    if (s.listening) return resolve();
    s.once("listening", () => resolve());
    s.once("error", reject);
  });
  const addr = servers[0]!.address() as AddressInfo;
  return { servers, port: addr.port };
}

async function closeServers(servers: net.Server[]): Promise<void> {
  await Promise.all(
    servers.map(
      (s) =>
        new Promise<void>((resolve) => {
          // Defence in depth: kill any still-established sockets before
          // awaiting close() — a flaky connection shouldn't strand the suite.
          const server = s as net.Server & {
            closeAllConnections?: () => void;
          };
          server.closeAllConnections?.();
          s.close(() => resolve());
        }),
    ),
  );
}

// -----------------------------------------------------------------------------

let currentServers: net.Server[] = [];
let currentUpstreams: MockUpstream[] = [];

afterEach(async () => {
  await closeServers(currentServers);
  currentServers = [];
  for (const u of currentUpstreams) await u.close();
  currentUpstreams = [];
});

describe("startLocalSandboxIngress", () => {
  it("routes all paths to the daemon port — daemon's proxy strips CSP + handles dev-server forwarding", async () => {
    const daemon = await startUpstream("DAEMON");
    currentUpstreams.push(daemon);

    const runner = runnerFor({
      alpha: { daemon: daemon.port },
    });
    const { servers, port } = await startIngress(() => runner);
    currentServers = servers;

    // Non-API path: daemon's catch-all proxies to the dev server (strips
    // CSP + injects HMR bootstrap along the way). Ingress never talks to
    // dev port directly.
    const res = await sendHttp(port, "alpha.localhost", "/index.html");
    expect(res.status).toBe(200);
    expect(res.body).toBe("DAEMON");
    expect(daemon.received()).toContain("GET /index.html HTTP/1.1");
    expect(daemon.received()).toContain("Host: alpha.localhost");
  });

  it("routes /_decopilot_vm/* paths to the daemon port", async () => {
    const daemon = await startUpstream("DAEMON");
    currentUpstreams.push(daemon);

    const runner = runnerFor({ alpha: { daemon: daemon.port } });
    const { servers, port } = await startIngress(() => runner);
    currentServers = servers;

    const res = await sendHttp(
      port,
      "alpha.localhost",
      "/_decopilot_vm/events",
    );
    expect(res.status).toBe(200);
    expect(daemon.received()).toContain("GET /_decopilot_vm/events HTTP/1.1");
  });

  it("accepts a host with an explicit port suffix (e.g. …:7070)", async () => {
    const daemon = await startUpstream("DAEMON");
    currentUpstreams.push(daemon);

    const runner = runnerFor({ alpha: { daemon: daemon.port } });
    const { servers, port } = await startIngress(() => runner);
    currentServers = servers;

    const res = await sendHttp(port, "alpha.localhost:7070", "/ok");
    expect(res.status).toBe(200);
    expect(res.body).toBe("DAEMON");
  });

  it("treats the subdomain match as case-insensitive", async () => {
    const daemon = await startUpstream("DAEMON");
    currentUpstreams.push(daemon);

    // The handle is captured as-is from the Host header, so the runner mock
    // must recognize the uppercase form — the regex itself is /i.
    const runner = runnerFor({ Alpha: { daemon: daemon.port } });
    const { servers, port } = await startIngress(() => runner);
    currentServers = servers;

    const res = await sendHttp(port, "Alpha.LOCALHOST", "/x");
    expect(res.status).toBe(200);
  });

  it("returns 404 for a host that isn't under *.localhost", async () => {
    const runner = runnerFor({});
    const { servers, port } = await startIngress(() => runner);
    currentServers = servers;

    const res = await sendHttp(port, "example.com", "/foo");
    expect(res.status).toBe(404);
    expect(res.body).toContain("Not a Sandbox Host");
  });

  it("returns 503 when the runner has not been initialized", async () => {
    const { servers, port } = await startIngress(() => null);
    currentServers = servers;

    const res = await sendHttp(port, "alpha.localhost", "/x");
    expect(res.status).toBe(503);
    expect(res.body).toContain("Sandbox Runner Not Initialized");
    // CORS * is required so the browser's probeMissing can observe ingress
    // errors (otherwise fetch throws a CORS block and the provider reconnects
    // forever instead of detecting sandbox-gone).
    expect(res.raw.toLowerCase()).toContain("access-control-allow-origin: *");
  });

  it("returns 404 when the handle is unknown (runner returns null)", async () => {
    const runner = runnerFor({}); // no entries → both resolvers return null
    const { servers, port } = await startIngress(() => runner);
    currentServers = servers;

    const res = await sendHttp(port, "ghost.localhost", "/x");
    expect(res.status).toBe(404);
    expect(res.body).toContain("Sandbox Not Found");
  });

  it("returns 400 on a malformed request line", async () => {
    const runner = runnerFor({});
    const { servers, port } = await startIngress(() => runner);
    currentServers = servers;

    // Missing spaces → parts.length < 3 → parseRequestHead returns null.
    const res = await sendRaw(port, "GARBAGE\r\nHost: foo\r\n\r\n");
    expect(res.status).toBe(400);
    expect(res.body).toContain("Bad Request");
  });

  it("returns 431 when headers exceed MAX_HEADER_BYTES without a terminator", async () => {
    const runner = runnerFor({});
    const { servers, port } = await startIngress(() => runner);
    currentServers = servers;

    // Deliberately no \r\n\r\n. A single oversized header line with no
    // terminator forces the > MAX_HEADER_BYTES branch.
    const oversized =
      "GET / HTTP/1.1\r\nHost: a.localhost\r\nX: " + "y".repeat(20 * 1024);
    const res = await sendRaw(port, oversized);
    expect(res.status).toBe(431);
    expect(res.body).toContain("Request Header Fields Too Large");
  });

  it("does not reach the runner when the host is non-sandbox (no resolver calls)", async () => {
    const calls: string[] = [];
    const runner = {
      resolveDevPort: async (h: string) => {
        calls.push(`dev:${h}`);
        return null;
      },
      resolveDaemonPort: async (h: string) => {
        calls.push(`daemon:${h}`);
        return null;
      },
    } as unknown as DockerSandboxRunner;

    const { servers, port } = await startIngress(() => runner);
    currentServers = servers;

    await sendHttp(port, "example.com", "/x");
    expect(calls).toEqual([]);
  });
});
