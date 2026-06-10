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

export function isDevLinkToxiProxyEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.DECO_DEV_LINK_TOXIPROXY === "1";
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
  const upstreamPort =
    server.port.length > 0 ? Number.parseInt(server.port, 10) : 80;
  const publicTargetUrl = `http://127.0.0.1:${upstreamPort}`;
  const clusterUrl = `http://127.0.0.1:${input.listenPort}`;
  return {
    serviceName: DEV_LINK_TOXIPROXY_SERVICE_NAME,
    proxyName: DEV_LINK_TOXIPROXY_PROXY_NAME,
    apiUrl: `http://127.0.0.1:${input.apiPort}`,
    listen: `0.0.0.0:${input.listenPort}`,
    upstream: `host.docker.internal:${upstreamPort}`,
    publicTargetUrl,
    clusterUrl,
    logLine: `[dev-link-toxiproxy] ready: ${clusterUrl} -> ${publicTargetUrl}`,
  };
}
