/**
 * Dev-only Docker ingress forwarder. Raw TCP proxy (not node:http — Bun's
 * `upgrade` event hands off a socket whose writes never reach the client).
 * Binds both 127.0.0.1 and ::1 for Chrome Happy-Eyeballs; default port 7070
 * because macOS AirPlay owns 7000. `*.localhost` resolves to loopback
 * natively (RFC 6761). Not wired in prod (Freestyle/K8s have real ingress).
 */

import * as net from "node:net";

/**
 * Probe a single host:port to see if it can be bound. Resolves to true when
 * the listen succeeds; false on EADDRINUSE; rejects on other errors so we
 * surface unexpected failure (permission denied, invalid host) early.
 */
function isPortFree(host: string, port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const tester = net.createServer();
    tester.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        resolve(false);
        return;
      }
      reject(err);
    });
    tester.once("listening", () => {
      tester.close(() => resolve(true));
    });
    tester.listen(port, host);
  });
}

/**
 * Scan a port range and return the first port that is free on BOTH IPv4
 * loopback (127.0.0.1) and IPv6 loopback (::1). Required because the ingress
 * binds both families for Chrome Happy-Eyeballs, and binding only one would
 * leave races on dual-stack hosts.
 *
 * Used by mesh's boot wiring to pick an ingress port that doesn't collide
 * with other studio dev servers (e.g. Conductor running parallel workspaces).
 */
export async function findFreeIngressPort(
  start: number,
  count = 20,
): Promise<number> {
  for (let i = 0; i < count; i++) {
    const port = start + i;
    if (
      (await isPortFree("127.0.0.1", port)) &&
      (await isPortFree("::1", port))
    ) {
      return port;
    }
  }
  throw new Error(
    `[studio-sandbox-ingress] no free port in range ${start}-${start + count - 1}`,
  );
}

const HOST_RE = /^([^.]+)\.localhost(?::\d+)?$/i;
const MAX_HEADER_BYTES = 16 * 1024;
const HEADERS_TERMINATOR = Buffer.from("\r\n\r\n");

/**
 * Structural view: any runner that can map a handle to a host-side daemon
 * TCP port. Both DockerSandboxRunner and HostSandboxRunner implement this.
 */
export interface DaemonPortResolver {
  resolveDaemonPort(handle: string): Promise<number | null>;
}

function extractHandle(hostHeader: string | null): string | null {
  if (!hostHeader) return null;
  const m = HOST_RE.exec(hostHeader);
  return m ? (m[1] ?? null) : null;
}

function parseRequestHead(
  headerText: string,
): { path: string; host: string | null } | null {
  const firstCrlf = headerText.indexOf("\r\n");
  if (firstCrlf === -1) return null;
  const requestLine = headerText.slice(0, firstCrlf);
  const parts = requestLine.split(" ");
  if (parts.length < 3) return null;
  const path = parts[1] ?? "/";
  let host: string | null = null;
  for (const line of headerText.slice(firstCrlf + 2).split("\r\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    if (line.slice(0, colon).toLowerCase() === "host") {
      host = line.slice(colon + 1).trim();
      break;
    }
  }
  return { path, host };
}

/**
 * All browser traffic hits the daemon port — the daemon's catch-all proxy
 * strips CSP/X-Frame-Options + injects the HMR bootstrap for HTML responses,
 * and its `/_decopilot_vm/*` + `/health` routes are served in-process. Dev
 * server traffic is forwarded onward from the daemon, never exposed directly.
 */
async function resolveTarget(
  runner: DaemonPortResolver,
  handle: string,
): Promise<number | null> {
  const port = await runner.resolveDaemonPort(handle);
  return port ?? null;
}

/**
 * `getRunner` is called per-request — the runner is lazy-init'd on first
 * sandbox use. Returning null → 503 (correct before any sandbox exists).
 */
export function startLocalSandboxIngress(
  getRunner: () => DaemonPortResolver | null,
  port: number,
): net.Server[] {
  const handleConnection = (client: net.Socket): void => {
    let buffer: Buffer = Buffer.alloc(0);
    // Guards fail() against writing a response twice. Must NOT be set when
    // headers finish arriving — route() hasn't responded yet, and tripping
    // this flag early makes every fail() inside route a no-op (silent hang).
    let responded = false;

    // CORS * on errors: the browser talks to this ingress directly (see
    // VmEventsProvider). Without it, a 404 / 503 / 400 surfaces as a generic
    // CORS block and probeMissing can't tell "sandbox gone" from a transient
    // failure, stranding the UI on a permanent reconnect loop.
    const fail = (status: number, message: string): void => {
      if (responded) return;
      responded = true;
      const body = `${message}\n`;
      client.end(
        `HTTP/1.1 ${status} ${message}\r\n` +
          `Content-Type: text/plain; charset=utf-8\r\n` +
          `Content-Length: ${Buffer.byteLength(body)}\r\n` +
          `Access-Control-Allow-Origin: *\r\n` +
          `Connection: close\r\n\r\n${body}`,
      );
    };

    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf(HEADERS_TERMINATOR);
      if (end === -1) {
        if (buffer.length > MAX_HEADER_BYTES) {
          client.off("data", onData);
          fail(431, "Request Header Fields Too Large");
        }
        return;
      }
      client.off("data", onData);
      const headerText = buffer.slice(0, end).toString("utf8");
      void route(headerText);
    };

    const route = async (headerText: string): Promise<void> => {
      const head = parseRequestHead(headerText);
      if (!head) {
        fail(400, "Bad Request");
        return;
      }
      const handle = extractHandle(head.host);
      const runner = getRunner();
      if (!runner) {
        fail(503, "Sandbox Runner Not Initialized");
        return;
      }
      if (!handle) {
        fail(404, "Not a Sandbox Host");
        return;
      }
      try {
        // Fast-fail malformed request lines; daemon would 400 anyway.
        new URL(head.path, "http://local");
      } catch {
        fail(400, "Bad Request");
        return;
      }
      const target = await resolveTarget(runner, handle);
      if (!target) {
        fail(404, "Sandbox Not Found");
        return;
      }
      const upstream = net.connect(target, "127.0.0.1", () => {
        upstream.write(buffer);
        buffer = Buffer.alloc(0);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.on("error", () => client.destroy());
      client.on("error", () => upstream.destroy());
      client.on("close", () => upstream.destroy());
      upstream.on("close", () => client.destroy());
    };

    client.on("data", onData);
    client.on("error", () => {
      /* surfaced via close */
    });
  };

  const bind = (host: string): net.Server => {
    const server = net.createServer(handleConnection);
    const MAX_RETRIES = 20; // ~10s at 500ms; covers the previous process's drain.
    let attempt = 0;
    let warnedInUse = false;
    // Single persistent 'listening' handler — listen(callback) would attach
    // one per retry and trip MaxListenersExceededWarning after ~10 EADDRINUSE.
    server.on("listening", () => {
      console.log(
        `[studio-sandbox-ingress] forwarding *.localhost → ${host}:${port}`,
      );
    });
    const tryListen = (): void => {
      server.listen(port, host);
    };
    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE" && attempt < MAX_RETRIES) {
        if (!warnedInUse) {
          warnedInUse = true;
          console.warn(
            `[studio-sandbox-ingress] ${host}:${port} in use — waiting for previous process to release (up to ${MAX_RETRIES / 2}s)...`,
          );
        }
        attempt++;
        setTimeout(tryListen, 500);
        return;
      }
      if (err.code === "EADDRINUSE") {
        const hint =
          port === 7000
            ? " (port 7000 is grabbed by macOS AirPlay Receiver — set SANDBOX_INGRESS_PORT to another port, e.g. 7070)"
            : " — another process is holding it; find it with `lsof -iTCP:" +
              port +
              " -sTCP:LISTEN -n -P`";
        console.warn(
          `[studio-sandbox-ingress] ${host}:${port} still in use after ${MAX_RETRIES / 2}s; giving up${hint}.`,
        );
        return;
      }
      console.warn(
        `[studio-sandbox-ingress] ${host}:${port} listen error: ${err.message}`,
      );
    });
    tryListen();
    return server;
  };

  // Bind both loopback families for Happy-Eyeballs (Chrome prefers IPv6).
  return [bind("127.0.0.1"), bind("::1")];
}
