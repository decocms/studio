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
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

/**
 * Run one of the script's functions with a stub `kubectl` first on PATH — the
 * developer running this has a live kube context and renew_shutdown patches.
 */
async function runWithFakeKubectl(snippet: string): Promise<string> {
  const bin = await mkdtemp(join(tmpdir(), "housekeeper-bin-"));
  await Bun.write(`${bin}/kubectl`, '#!/bin/sh\necho "kubectl $*"\n');
  await Bun.spawn(["chmod", "+x", `${bin}/kubectl`]).exited;
  const proc = Bun.spawn(["sh", "-c", `. "$1"; ${snippet}`, "sh", SCRIPT], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
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
  });
  return (await new Response(proc.stdout).text()).trim();
}

describe("housekeeper renew_shutdown", () => {
  // `date -u -d @<epoch>` is a GNU extension the sweep's busybox image doesn't
  // have, so the conversion is hand-rolled — which makes it worth proving.
  it("converts epoch seconds to a UTC RFC-3339 stamp", async () => {
    expect(await runWithFakeKubectl("iso_from_epoch 1776175716")).toBe(
      new Date(1776175716 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"),
    );
  });

  it("renews to now + TTL, not to a bad-timestamp no-op", async () => {
    const out = await runWithFakeKubectl("renew_shutdown my-claim 1234");
    expect(out).toContain("renew claim=my-claim idle_ms=1234");
    expect(out).not.toContain("renew-skip");
    const stamp = out.match(/shutdown_at=(\S+)/)?.[1];
    expect(stamp).toBeDefined();
    const deltaMs = new Date(stamp as string).getTime() - Date.now();
    // Renewal is now + TTL; a couple of seconds of slack for process startup.
    expect(deltaMs).toBeGreaterThan(TTL_MS - 5_000);
    expect(deltaMs).toBeLessThanOrEqual(TTL_MS);
  });
});
