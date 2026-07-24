import { retry, RetryError } from "@decocms/shared/std";

export const DEV_LINK_TOXIPROXY_SERVICE_NAME = "ToxiProxy";
export const DEV_LINK_TOXIPROXY_PROXY_NAME = "dev_link_studio";

const TOXIPROXY_READY_MAX_ATTEMPTS = 20;
const TOXIPROXY_READY_INTERVAL_MS = 100;
const TOXIPROXY_READY_ATTEMPT_TIMEOUT_MS = 100;

export interface DevLinkToxiProxyConfigInput {
  serverUrl: string;
  apiPort: number;
  listenPort: number;
}

export interface DevLinkToxiProxyConfig {
  serviceName: typeof DEV_LINK_TOXIPROXY_SERVICE_NAME;
  proxyName: typeof DEV_LINK_TOXIPROXY_PROXY_NAME;
  apiUrl: string;
  listen: string;
  upstream: string;
  publicTargetUrl: string;
  clusterUrl: string;
  logLine: string;
}

export interface EnsureDevLinkToxiProxyInput
  extends DevLinkToxiProxyConfigInput {
  startDaemon?: (apiPort: number, listenPort: number) => Promise<void>;
  stopDaemon?: (apiPort: number, listenPort: number) => Promise<void>;
  fetchImpl?: typeof fetch;
}

export interface DevLinkToxiProxyHandle {
  config: DevLinkToxiProxyConfig;
  stop: () => Promise<void>;
}

export function isDevLinkToxiProxyEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.DECO_DEV_LINK_TOXIPROXY === "1";
}

function assertValidPort(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${name} must be an integer port in 1..65535`);
  }
  return value;
}

export function buildDevLinkToxiProxyConfig(
  input: DevLinkToxiProxyConfigInput,
): DevLinkToxiProxyConfig {
  const server = new URL(input.serverUrl);
  if (server.protocol !== "http:") {
    throw new Error(
      "DECO_DEV_LINK_TOXIPROXY only supports http local Studio URLs",
    );
  }
  const apiPort = assertValidPort(input.apiPort, "apiPort");
  const listenPort = assertValidPort(input.listenPort, "listenPort");
  if (server.port.length === 0) {
    throw new Error("serverUrl must include an explicit valid port");
  }
  const upstreamPort = assertValidPort(
    Number.parseInt(server.port, 10),
    "upstreamPort",
  );
  const publicTargetUrl = `http://127.0.0.1:${upstreamPort}`;
  const clusterUrl = `http://127.0.0.1:${listenPort}`;
  return {
    serviceName: DEV_LINK_TOXIPROXY_SERVICE_NAME,
    proxyName: DEV_LINK_TOXIPROXY_PROXY_NAME,
    apiUrl: `http://127.0.0.1:${apiPort}`,
    listen: `0.0.0.0:${listenPort}`,
    upstream: `host.docker.internal:${upstreamPort}`,
    publicTargetUrl,
    clusterUrl,
    logLine: `[dev-link-toxiproxy] ready: ${clusterUrl} -> ${publicTargetUrl}`,
  };
}

export function resolveDevLinkClusterUrl(input: {
  serverUrl: string;
  toxiproxy: DevLinkToxiProxyConfig | null;
}): string {
  return input.toxiproxy?.clusterUrl ?? input.serverUrl;
}

async function assertToxiProxyResponseOk(
  response: Response,
  context: string,
  url: string,
): Promise<void> {
  if (response.ok) {
    return;
  }
  const body = await response.text();
  throw new Error(
    `ToxiProxy ${context} failed for ${url}: status=${response.status} statusText=${response.statusText} body=${body}`,
  );
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
  if (!(error instanceof Error)) {
    return false;
  }
  if (error.name === "TimeoutError") {
    return true;
  }
  return isTimeoutError(error.cause);
}

async function fetchToxiProxy(
  fetchImpl: typeof fetch,
  context: string,
  url: string,
  init?: RequestInit,
): Promise<Response> {
  try {
    return await fetchImpl(url, init);
  } catch (error) {
    throw new Error(
      `ToxiProxy ${context} failed for ${url}: ${errorMessage(error)}`,
      {
        cause: error,
      },
    );
  }
}

export async function populateDevLinkToxiProxy(
  config: DevLinkToxiProxyConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const resetUrl = `${config.apiUrl}/reset`;
  const resetResponse = await fetchToxiProxy(fetchImpl, "reset", resetUrl, {
    method: "POST",
  });
  await assertToxiProxyResponseOk(resetResponse, "reset", resetUrl);

  const populateUrl = `${config.apiUrl}/populate`;
  const populateResponse = await fetchToxiProxy(
    fetchImpl,
    "populate",
    populateUrl,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify([
        {
          name: config.proxyName,
          listen: config.listen,
          upstream: config.upstream,
          enabled: true,
        },
      ]),
    },
  );
  await assertToxiProxyResponseOk(populateResponse, "populate", populateUrl);
}

async function waitForDevLinkToxiProxy(
  config: DevLinkToxiProxyConfig,
  fetchImpl: typeof fetch,
): Promise<void> {
  const versionUrl = `${config.apiUrl}/version`;
  try {
    await retry(
      async () => {
        const response = await fetchToxiProxy(
          fetchImpl,
          "readiness check",
          versionUrl,
          {
            method: "GET",
            signal: AbortSignal.timeout(TOXIPROXY_READY_ATTEMPT_TIMEOUT_MS),
          },
        );
        await assertToxiProxyResponseOk(
          response,
          "readiness check",
          versionUrl,
        );
      },
      {
        maxAttempts: TOXIPROXY_READY_MAX_ATTEMPTS,
        minTimeout: TOXIPROXY_READY_INTERVAL_MS,
        maxTimeout: TOXIPROXY_READY_INTERVAL_MS,
        multiplier: 1,
        jitter: 0,
        isRetriable: (error) => !isTimeoutError(error),
      },
    );
  } catch (error) {
    const cause = error instanceof RetryError ? error.cause : error;
    throw new Error(
      `ToxiProxy API did not become ready at ${versionUrl}: ${errorMessage(cause)}`,
      {
        cause,
      },
    );
  }
}

async function drainStderr(
  stream: ReadableStream<Uint8Array> | null,
): Promise<string> {
  if (stream === null) {
    return "";
  }
  return await new Response(stream).text();
}

async function runDockerCommand(
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
        {
          cause: error,
        },
      );
    }
  })();
  const [exitCode, stderr] = await Promise.all([
    proc.exited,
    drainStderr(proc.stderr),
  ]);
  if (exitCode === 0 || options.ignoreFailure === true) {
    return;
  }
  const suffix = stderr.trim().length > 0 ? `: ${stderr.trim()}` : "";
  throw new Error(
    `Docker command failed (${command}) with exit ${exitCode}${suffix}`,
  );
}

async function startDevLinkToxiProxyDocker(
  apiPort: number,
  listenPort: number,
): Promise<void> {
  const containerName = `deco-dev-link-toxiproxy-${apiPort}`;
  await runDockerCommand(["rm", "-f", containerName], { ignoreFailure: true });
  await runDockerCommand([
    "run",
    "--rm",
    "-d",
    "--name",
    containerName,
    "-p",
    `127.0.0.1:${apiPort}:8474`,
    "-p",
    `127.0.0.1:${listenPort}:${listenPort}`,
    "ghcr.io/shopify/toxiproxy:2.12.0",
    "-host=0.0.0.0",
  ]);
}

async function stopDevLinkToxiProxyDocker(
  apiPort: number,
  _listenPort: number,
): Promise<void> {
  const containerName = `deco-dev-link-toxiproxy-${apiPort}`;
  await runDockerCommand(["rm", "-f", containerName], { ignoreFailure: true });
}

export async function ensureDevLinkToxiProxy(
  input: EnsureDevLinkToxiProxyInput,
): Promise<DevLinkToxiProxyHandle> {
  const config = buildDevLinkToxiProxyConfig(input);
  const startDaemon = input.startDaemon ?? startDevLinkToxiProxyDocker;
  const stopDaemon =
    input.stopDaemon ??
    (input.startDaemon === undefined ? stopDevLinkToxiProxyDocker : undefined);
  await startDaemon(input.apiPort, input.listenPort);
  const fetchImpl = input.fetchImpl ?? fetch;
  try {
    await waitForDevLinkToxiProxy(config, fetchImpl);
    await populateDevLinkToxiProxy(config, fetchImpl);
  } catch (error) {
    if (stopDaemon !== undefined) {
      try {
        await stopDaemon(input.apiPort, input.listenPort);
      } catch {
        /* best-effort cleanup */
      }
    }
    throw error;
  }
  return {
    config,
    stop: async () => {
      if (stopDaemon !== undefined) {
        await stopDaemon(input.apiPort, input.listenPort);
      }
    },
  };
}
