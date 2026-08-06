/**
 * housekeeper-sweep.sh — `probe_daemon` classification, against a real HTTP
 * server and the real script (sourced with HOUSEKEEPER_SOURCE_ONLY=1, which
 * stops before the kubectl half).
 *
 * The case that matters most: a tenant warm-pool pod is bootstrapped but
 * unbound, so it reports `claimed:false` with a huge idleMs. If the sweep
 * treats that as idle, warming a pool is what kills it — every pod reaped
 * 15 minutes after Studio warms it, forever.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

const SCRIPT = new URL("./housekeeper-sweep.sh", import.meta.url).pathname;
const TTL_MS = 15 * 60 * 1000;
const PAST_TTL_MS = TTL_MS + 60_000;

let server: ReturnType<typeof Bun.serve>;
/** Path → what the fake daemon answers on /_sandbox/idle. */
const responses = new Map<string, { status: number; body: string }>();

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      const canned = responses.get(path);
      if (!canned) return new Response("no route", { status: 404 });
      return new Response(canned.body, { status: canned.status });
    },
  });
});
afterAll(() => server.stop(true));

/**
 * Run the script's `probe_daemon` against the fake daemon. The script wants an
 * `ip` and appends `:9000`, so the fake serves on 9000 via a per-case path —
 * instead we point it at host:port by overriding DAEMON_PORT after sourcing.
 */
async function probe(idleJson: string, status = 200): Promise<string> {
  responses.set("/_sandbox/idle", { status, body: idleJson });
  const proc = Bun.spawn(
    [
      "sh",
      "-c",
      `. "$1"; DAEMON_PORT=${server.port}; probe_daemon 127.0.0.1`,
      "sh",
      SCRIPT,
    ],
    {
      env: {
        ...process.env,
        HOUSEKEEPER_SOURCE_ONLY: "1",
        NS: "test",
        TTL_MS: String(TTL_MS),
        PROBE_TIMEOUT_SEC: "5",
        CLAIM_SELECTOR: "x=y",
        POD_SELECTOR: "x=y",
        RUN_ID: "test",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const out = await new Response(proc.stdout).text();
  return out.trim();
}

describe("housekeeper probe_daemon", () => {
  it("skips a warmed-but-unbound tenant pool pod past the idle TTL", async () => {
    // What a bootstrapped pool pod reports: a workload, no user, idle for
    // hours because nobody has claimed it yet.
    expect(
      await probe(
        JSON.stringify({
          lastActivityAt: "2026-08-06T00:00:00.000Z",
          idleMs: PAST_TTL_MS,
          claimed: false,
          prewarmed: true,
        }),
      ),
    ).toBe("__unclaimed__");
  });

  it("reaps a claimed pod past the idle TTL", async () => {
    expect(
      await probe(
        JSON.stringify({
          idleMs: PAST_TTL_MS,
          claimed: true,
          prewarmed: false,
        }),
      ),
    ).toBe(String(PAST_TTL_MS));
  });

  it("treats an absent `claimed` as claimed (pre-warm-pool daemons)", async () => {
    expect(await probe(JSON.stringify({ idleMs: PAST_TTL_MS }))).toBe(
      String(PAST_TTL_MS),
    );
  });

  it("reports a 200 with no parseable idleMs as bad shape, not idle", async () => {
    expect(await probe(JSON.stringify({ claimed: true }))).toBe(
      "__bad_shape__",
    );
  });

  it("reports a 5xx as a server error, not idle", async () => {
    expect(await probe("boom", 500)).toBe("__server_error__");
  });
});
