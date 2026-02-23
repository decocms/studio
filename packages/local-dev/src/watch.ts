import { watch } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";

export function handleWatch(
  req: IncomingMessage,
  res: ServerResponse,
  rootPath: string,
): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });

  // Send initial keepalive
  res.write(": connected\n\n");

  const watcher = watch(
    rootPath,
    { recursive: true },
    (eventType, filename) => {
      if (!filename) return;
      const event = JSON.stringify({
        path: filename,
        type: eventType,
        timestamp: Date.now(),
      });
      res.write(`data: ${event}\n\n`);
    },
  );

  // Keepalive ping every 30s to prevent proxy timeouts
  const pingInterval = setInterval(() => {
    res.write(": ping\n\n");
  }, 30000);

  req.on("close", () => {
    watcher.close();
    clearInterval(pingInterval);
  });
}
