import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { connect } from "nats";
import { ensureLocalNatsServer, type LocalNatsServer } from "./local-server";

const TEST_PORT = 14222;
const TEST_DATA_DIR = "./data/test-nats";

beforeAll(() => {
  if (!Bun.which("nats-server")) {
    console.warn("Skipping local-server tests: nats-server not on PATH");
    process.exit(0);
  }
});

describe("ensureLocalNatsServer", () => {
  let servers: LocalNatsServer[] = [];

  afterEach(async () => {
    for (const s of servers) {
      await s.stop();
    }
    servers = [];
    await new Promise((r) => setTimeout(r, 300));

    try {
      rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  test("spawns nats-server when not running", async () => {
    const server = await ensureLocalNatsServer(TEST_DATA_DIR, TEST_PORT);
    servers.push(server);

    expect(server.url).toBe(`nats://127.0.0.1:${TEST_PORT}`);
    expect(server.token).toBeDefined();

    const nc = await connect({ servers: server.url, token: server.token });
    await nc.drain();
  });

  test("reuses existing server (second instance gets same URL)", async () => {
    const server1 = await ensureLocalNatsServer(TEST_DATA_DIR, TEST_PORT);
    servers.push(server1);

    const server2 = await ensureLocalNatsServer(TEST_DATA_DIR, TEST_PORT);
    servers.push(server2);

    expect(server2.url).toBe(server1.url);

    await server2.stop();

    const nc = await connect({ servers: server1.url, token: server1.token });
    await nc.drain();
  });

  test("stop kills server and releases port", async () => {
    const server = await ensureLocalNatsServer(TEST_DATA_DIR, TEST_PORT);
    await server.stop();

    await expect(
      connect({ servers: `nats://127.0.0.1:${TEST_PORT}`, timeout: 1000 }),
    ).rejects.toThrow();
  });

  test("throws descriptive error when nats-server not on PATH", async () => {
    const originalPath = process.env.PATH;
    process.env.PATH = "";
    try {
      await expect(
        ensureLocalNatsServer(TEST_DATA_DIR, TEST_PORT + 1),
      ).rejects.toThrow("nats-server not found");
    } finally {
      process.env.PATH = originalPath;
    }
  });
});
