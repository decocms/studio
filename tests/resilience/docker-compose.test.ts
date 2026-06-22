import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const composePath = join(import.meta.dir, "docker-compose.yml");

describe("resilience docker-compose", () => {
  test("NATS healthcheck does not depend on shell utilities in the image", () => {
    const compose = readFileSync(composePath, "utf8");
    const natsService = compose.match(
      /^  nats:\n(?<body>(?:    .*\n|\n)*?)(?=^  [a-zA-Z0-9_-]+:)/m,
    )?.groups?.body;

    expect(natsService).toBeDefined();
    expect(natsService).not.toContain("CMD-SHELL");
    expect(natsService).not.toContain("wget");
    expect(natsService).toContain('["CMD", "nats-server", "--help"]');
  });
});
