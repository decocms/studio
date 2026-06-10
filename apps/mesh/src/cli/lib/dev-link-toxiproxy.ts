export const DEV_LINK_TOXIPROXY_SERVICE_NAME = "ToxiProxy";
export const DEV_LINK_TOXIPROXY_PROXY_NAME = "dev_link_studio";

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
  fetchImpl?: typeof fetch;
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

async function assertToxiProxyResponseOk(
  response: Response,
  context: string,
): Promise<void> {
  if (response.ok) {
    return;
  }
  const body = await response.text();
  throw new Error(
    `ToxiProxy ${context} failed: status=${response.status} statusText=${response.statusText} body=${body}`,
  );
}

export async function populateDevLinkToxiProxy(
  config: DevLinkToxiProxyConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const resetResponse = await fetchImpl(`${config.apiUrl}/reset`, {
    method: "POST",
  });
  await assertToxiProxyResponseOk(resetResponse, "reset");

  const populateResponse = await fetchImpl(`${config.apiUrl}/populate`, {
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
  });
  await assertToxiProxyResponseOk(populateResponse, "populate");
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
  const proc = Bun.spawn(["docker", ...args], {
    stdout: "ignore",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([
    proc.exited,
    drainStderr(proc.stderr),
  ]);
  if (exitCode === 0 || options.ignoreFailure === true) {
    return;
  }
  const command = ["docker", ...args].join(" ");
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

export async function ensureDevLinkToxiProxy(
  input: EnsureDevLinkToxiProxyInput,
): Promise<DevLinkToxiProxyConfig> {
  const config = buildDevLinkToxiProxyConfig(input);
  const startDaemon = input.startDaemon ?? startDevLinkToxiProxyDocker;
  await startDaemon(input.apiPort, input.listenPort);
  await populateDevLinkToxiProxy(config, input.fetchImpl ?? fetch);
  return config;
}
