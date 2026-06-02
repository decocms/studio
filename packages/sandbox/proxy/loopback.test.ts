import { describe, expect, test } from "bun:test";
import { bracketHost, pickLoopback } from "./loopback";

async function withServer(
  hostname: string,
  fn: (port: number) => Promise<void>,
): Promise<void> {
  const server = Bun.serve({ port: 0, hostname, fetch: () => new Response() });
  try {
    await fn(server.port);
  } finally {
    server.stop(true);
  }
}

describe("pickLoopback", () => {
  test("returns ::1 when an IPv6-only server is listening", async () => {
    await withServer("::1", async (port) => {
      expect(await pickLoopback(port)).toBe("::1");
    });
  });

  test("falls back to 127.0.0.1 when only IPv4 is listening", async () => {
    await withServer("127.0.0.1", async (port) => {
      expect(await pickLoopback(port)).toBe("127.0.0.1");
    });
  });

  test("returns null when neither loopback responds", async () => {
    const port = 49000 + Math.floor(Math.random() * 10000);
    expect(await pickLoopback(port)).toBeNull();
  });
});

describe("bracketHost", () => {
  test("wraps IPv6 in brackets", () => {
    expect(bracketHost("::1")).toBe("[::1]");
  });

  test("leaves IPv4 unchanged", () => {
    expect(bracketHost("127.0.0.1")).toBe("127.0.0.1");
  });
});
