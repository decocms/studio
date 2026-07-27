import { sleep } from "@decocms/shared/std";
import { createServer } from "node:net";

const LOCALHOST_ENDPOINTS = ["localhost", "127.0.0.1", "0.0.0.0"];

/**
 * Probe each localhost-flavoured endpoint and return the first one where
 * binding `port` fails — i.e. something is already listening there.
 * Returns null if the port is free everywhere.
 */
export async function findRunningAddr(port: number): Promise<string | null> {
  for (const host of LOCALHOST_ENDPOINTS) {
    const inUse = await isPortInUse(port, host);
    if (inUse) return host;
  }
  return null;
}

export interface WaitForPortOptions {
  intervalMs?: number;
  /** Injectable wait — tests sequence polls manually instead of real time. */
  sleepFn?: (ms: number) => Promise<void>;
}

/**
 * Resolve when something is listening on `port`. Polls every `intervalMs`.
 */
export async function waitForPort(
  port: number,
  { intervalMs = 1000, sleepFn = sleep }: WaitForPortOptions = {},
): Promise<string> {
  for (;;) {
    const addr = await findRunningAddr(port);
    if (addr) return addr;
    await sleepFn(intervalMs);
  }
}

export function isPortInUse(port: number, host: string): Promise<boolean> {
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
