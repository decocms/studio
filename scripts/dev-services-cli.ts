#!/usr/bin/env bun
import {
  ensureServices,
  getStatus,
  printTable,
  stopServices,
} from "./dev-services.ts";

const command = process.argv[2];

switch (command) {
  case "up": {
    await ensureServices();
    break;
  }
  case "down": {
    await stopServices();
    break;
  }
  case "status": {
    const services = await getStatus();
    printTable(services);
    break;
  }
  default: {
    console.log("Usage: bun run scripts/dev-services-cli.ts <up|down|status>");
    process.exit(1);
  }
}
