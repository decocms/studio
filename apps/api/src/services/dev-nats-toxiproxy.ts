/**
 * Dev-only chaos harness that inserts a Toxiproxy hop **only** on the link
 * daemon -> JetStream NATS leg.
 *
 * Unlike {@link ../cli/lib/dev-link-toxiproxy} (which proxies the daemon's HTTP
 * cluster URL), this proxies the raw NATS TCP connection the daemon dials. The
 * cluster keeps connecting to NATS directly (via `outputs.natsUrls`); only the
 * URL handed to the daemon through the link session is rewritten to the proxy.
 * That lets you inject latency / resets on the JetStream relay data plane while
 * leaving every HTTP route alone.
 *
 * Enable with `DECO_DEV_NATS_TOXIPROXY=1`. Requires Docker + that the embedded
 * NATS binds `0.0.0.0` (so the container can reach it via host.docker.internal)
 * — `ensureNats` does that when this mode is on.
 */
import { retry, RetryError } from "@decocms/shared/std";

const DEV_NATS_TOXIPROXY_PROXY_NAME = "dev_nats";

// Distinct from the HTTP dev-link-toxiproxy ports (18474/18480) so both harnesses
// can coexist without colliding.
const DEFAULT_API_PORT = 18475;
const DEFAULT_LISTEN_PORT = 18482;

const TOXIPROXY_IMAGE = "ghcr.io/shopify/toxiproxy:2.12.0";
const READY_MAX_ATTEMPTS = 20;
const READY_INTERVAL_MS = 100;
const READY_ATTEMPT_TIMEOUT_MS = 100;

export function isDevNatsToxiProxyEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.DECO_DEV_NATS_TOXIPROXY === "1";
}

export interface DevNatsToxiProxyConfig {
  proxyName: typeof DEV_NATS_TOXIPROXY_PROXY_NAME;
  containerName: string;
  /** Toxiproxy admin API base (add/remove toxics here). */
  apiUrl: string;
  /** Listen address inside the container. */
  listen: string;
  /** Upstream the proxy forwards to (the host's embedded NATS). */
  upstream: string;
  /** NATS URL handed to the daemon — points at the proxy listener. */
  publicUrl: string;
  apiPort: number;
  listenPort: number;
}

function assertPort(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${name} must be an integer port in 1..65535`);
  }
  return value;
}

export function buildDevNatsToxiProxyConfig(input: {
  natsPort: number;
  apiPort?: number;
  listenPort?: number;
}): DevNatsToxiProxyConfig {
  const natsPort = assertPort(input.natsPort, "natsPort");
  const apiPort = assertPort(input.apiPort ?? DEFAULT_API_PORT, "apiPort");
  const listenPort = assertPort(
    input.listenPort ?? DEFAULT_LISTEN_PORT,
    "listenPort",
  );
  return {
    proxyName: DEV_NATS_TOXIPROXY_PROXY_NAME,
    containerName: `deco-dev-nats-toxiproxy-${apiPort}`,
    apiUrl: `http://127.0.0.1:${apiPort}`,
    listen: `0.0.0.0:${listenPort}`,
    upstream: `host.docker.internal:${natsPort}`,
    publicUrl: `nats://127.0.0.1:${listenPort}`,
    apiPort,
    listenPort,
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.name === "Error"
      ? error.message
      : `${error.name}: ${error.message}`;
  }
  return String(error);
}

function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "TimeoutError") return true;
  return isTimeoutError(error.cause);
}

async function drainStderr(
  stream: ReadableStream<Uint8Array> | null,
): Promise<string> {
  if (stream === null) return "";
  return await new Response(stream).text();
}

async function runDocker(
  args: string[],
  options: { ignoreFailure?: boolean } = {},
): Promise<void> {
  const command = ["docker", ...args].join(" ");
  const proc = (() => {
    try {
      return Bun.spawn(["docker", ...args], {
        stdout: "ignore",
        stderr: "pipe",
      });
    } catch (error) {
      throw new Error(
        `Docker command failed to start (${command}): ${errorMessage(error)}`,
        { cause: error },
      );
    }
  })();
  const [exitCode, stderr] = await Promise.all([
    proc.exited,
    drainStderr(proc.stderr),
  ]);
  if (exitCode === 0 || options.ignoreFailure === true) return;
  const suffix = stderr.trim().length > 0 ? `: ${stderr.trim()}` : "";
  throw new Error(
    `Docker command failed (${command}) with exit ${exitCode}${suffix}`,
  );
}

async function startContainer(config: DevNatsToxiProxyConfig): Promise<void> {
  await runDocker(["rm", "-f", config.containerName], { ignoreFailure: true });
  await runDocker([
    "run",
    "--rm",
    "-d",
    "--name",
    config.containerName,
    "-p",
    `127.0.0.1:${config.apiPort}:8474`,
    "-p",
    `127.0.0.1:${config.listenPort}:${config.listenPort}`,
    TOXIPROXY_IMAGE,
    "-host=0.0.0.0",
  ]);
}

async function waitForApi(
  config: DevNatsToxiProxyConfig,
  fetchImpl: typeof fetch,
): Promise<void> {
  const versionUrl = `${config.apiUrl}/version`;
  try {
    await retry(
      async () => {
        const res = await fetchImpl(versionUrl, {
          method: "GET",
          signal: AbortSignal.timeout(READY_ATTEMPT_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`status ${res.status}`);
      },
      {
        maxAttempts: READY_MAX_ATTEMPTS,
        minTimeout: READY_INTERVAL_MS,
        maxTimeout: READY_INTERVAL_MS,
        multiplier: 1,
        jitter: 0,
        isRetriable: (error) => !isTimeoutError(error),
      },
    );
  } catch (error) {
    const cause = error instanceof RetryError ? error.cause : error;
    throw new Error(
      `ToxiProxy API not ready at ${versionUrl}: ${errorMessage(cause)}`,
      { cause },
    );
  }
}

async function populate(
  config: DevNatsToxiProxyConfig,
  fetchImpl: typeof fetch,
): Promise<void> {
  const res = await fetchImpl(`${config.apiUrl}/populate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify([
      {
        name: config.proxyName,
        listen: config.listen,
        upstream: config.upstream,
        enabled: true,
      },
    ]),
  });
  if (!res.ok) {
    throw new Error(
      `ToxiProxy populate failed: status=${res.status} body=${await res.text()}`,
    );
  }
}

export interface DevNatsToxiProxyHandle {
  config: DevNatsToxiProxyConfig;
  stop: () => Promise<void>;
}

export interface EnsureDevNatsToxiProxyInput {
  natsPort: number;
  apiPort?: number;
  listenPort?: number;
  /** Injectable for tests; defaults to a Docker-backed container. */
  startDaemon?: (config: DevNatsToxiProxyConfig) => Promise<void>;
  stopDaemon?: (config: DevNatsToxiProxyConfig) => Promise<void>;
  fetchImpl?: typeof fetch;
}

export async function ensureDevNatsToxiProxy(
  input: EnsureDevNatsToxiProxyInput,
): Promise<DevNatsToxiProxyHandle> {
  const config = buildDevNatsToxiProxyConfig(input);
  const startDaemon = input.startDaemon ?? startContainer;
  const stopDaemon =
    input.stopDaemon ??
    (input.startDaemon === undefined
      ? (c: DevNatsToxiProxyConfig) =>
          runDocker(["rm", "-f", c.containerName], { ignoreFailure: true })
      : undefined);
  const fetchImpl = input.fetchImpl ?? fetch;

  await startDaemon(config);
  try {
    await waitForApi(config, fetchImpl);
    await populate(config, fetchImpl);
  } catch (error) {
    if (stopDaemon !== undefined) {
      await stopDaemon(config).catch(() => {});
    }
    throw error;
  }
  return {
    config,
    stop: async () => {
      if (stopDaemon !== undefined) await stopDaemon(config);
    },
  };
}

/** Best-effort teardown of the NATS chaos container (used on dev shutdown). */
export async function stopDevNatsToxiProxy(
  apiPort: number = DEFAULT_API_PORT,
): Promise<void> {
  await runDocker(["rm", "-f", `deco-dev-nats-toxiproxy-${apiPort}`], {
    ignoreFailure: true,
  });
}
