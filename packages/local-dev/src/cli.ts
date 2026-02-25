#!/usr/bin/env node
import { resolve } from "node:path";
import { createLocalDevServer } from "./server.ts";

function parseArgs(): { rootPath: string; port: number } {
  const args = process.argv.slice(2);
  let rootPath = process.env.MCP_LOCAL_DEV_PATH ?? process.cwd();
  let port = parseInt(process.env.PORT ?? "4201", 10);

  const skipNext = new Set<number>();
  for (let i = 0; i < args.length; i++) {
    if (skipNext.has(i)) continue;
    if ((args[i] === "--port" || args[i] === "-p") && args[i + 1]) {
      port = parseInt(args[i + 1], 10);
      skipNext.add(i + 1);
      continue;
    }
    if (!args[i].startsWith("-")) {
      rootPath = args[i];
    }
  }

  if (isNaN(port) || port < 0 || port > 65535) {
    process.stderr.write(
      `[local-dev] Invalid port: ${port}. Must be between 0 and 65535.\n`,
    );
    process.exit(1);
  }

  return { rootPath: resolve(rootPath), port };
}

const { rootPath, port } = parseArgs();
const server = createLocalDevServer({ rootPath, port });

await server.start();

const actualPort = server.port;
process.stderr.write(`
[local-dev] MCP daemon running
  Root:    ${rootPath}
  Port:    ${actualPort}
  MCP:     http://localhost:${actualPort}/mcp
  Ready:   http://localhost:${actualPort}/_ready
  Watch:   http://localhost:${actualPort}/watch
`);
