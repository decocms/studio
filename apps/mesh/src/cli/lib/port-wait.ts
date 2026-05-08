import { createServer } from "node:net";

const LOCALHOST_ENDPOINTS = ["localhost", "127.0.0.1", "0.0.0.0"];

/**
 * Probe each localhost-flavoured endpoint and return the first one where
 * binding `port` fails — i.e. something is already listening there.
 * Returns null if the port is free everywhere.
 */
export async function findRunningAddr(port: number): Promise<string | null> {
  for (const host of LOCALHOST_ENDPOINTS) {
    const inUse = await isInUse(host, port);
    if (inUse) return host;
  }
  return null;
}

export interface WaitForPortOptions {
  intervalMs?: number;
}

/**
 * Resolve when something is listening on `port`. Polls every `intervalMs`.
 */
export async function waitForPort(
  port: number,
  { intervalMs = 1000 }: WaitForPortOptions = {},
): Promise<string> {
  for (;;) {
    const addr = await findRunningAddr(port);
    if (addr) return addr;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function isInUse(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", (err: NodeJS.ErrnoException) => {
      resolve(err.code === "EADDRINUSE");
    });
    srv.listen(port, host, () => {
      srv.close(() => resolve(false));
    });
  });
}
