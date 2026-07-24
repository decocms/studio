import { createServer } from "net";

/**
 * Check if a TCP port is available on localhost.
 */
function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "0.0.0.0", () => {
      srv.close(() => resolve(true));
    });
  });
}

/**
 * Return `port` if it is free, otherwise find a nearby available port.
 * Logs a warning when the original port is busy.
 */
export async function findAvailablePort(port: number): Promise<number> {
  if (await isPortAvailable(port)) {
    return port;
  }

  // Let the OS pick an available port
  const actualPort = await new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "0.0.0.0", () => {
      const addr = srv.address();
      const p = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(p));
    });
  });

  console.warn(`Port ${port} is in use, using port ${actualPort} instead.`);

  return actualPort;
}
