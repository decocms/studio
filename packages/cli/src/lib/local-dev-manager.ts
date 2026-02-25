/**
 * Local-dev daemon lifecycle manager.
 *
 * Inline-starts the local-dev MCP server in the same process
 * instead of spawning a separate binary.
 */

const DEFAULT_PORT = 4201;

/** Minimal interface matching LocalDevServer from @decocms/local-dev */
export interface LocalDevServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  port: number;
  rootPath: string;
}

/**
 * Start the local-dev MCP server inline for the given folder.
 *
 * If local-dev is already running on the port, returns null
 * (caller should treat null as "already running, nothing to manage").
 *
 * Otherwise, creates and starts the server, returning the instance.
 */
export async function startLocalDev(
  folder: string,
  port: number = DEFAULT_PORT,
): Promise<LocalDevServer | null> {
  // If already running on this port, nothing to do
  const alive = await probeLocalDev(port);
  if (alive) {
    return null;
  }

  // Use opaque dynamic import to prevent tsc from resolving local-dev's .ts files
  const moduleName = "@decocms/local-dev";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod = (await import(/* @vite-ignore */ moduleName)) as any;
  const server = mod.createLocalDevServer({
    rootPath: folder,
    port,
  }) as LocalDevServer;
  await server.start();
  return server;
}

/**
 * Stop a managed local-dev server instance.
 *
 * No-op if server is null.
 */
export async function stopLocalDev(
  server: LocalDevServer | null,
): Promise<void> {
  if (!server) return;
  await server.stop();
}

/**
 * Probe whether a local-dev daemon is alive on the given port.
 */
export async function probeLocalDev(
  port: number = DEFAULT_PORT,
): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${port}/_ready`, {
      signal: AbortSignal.timeout(500),
    });
    return res.ok;
  } catch {
    return false;
  }
}
