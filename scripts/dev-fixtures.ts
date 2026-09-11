/**
 * Bring a fresh checkout from zero to a project with every page populated.
 *
 * A worktree gets its OWN dev home (`/tmp/decocms-dev-<branch>`), so its
 * Postgres and MinIO start empty and `.env` is gitignored: opening this branch
 * somewhere new shows nothing until the upstreams are wired and the seeds run.
 * This is that, in one command, idempotent, in the order the pieces need:
 *
 *   1. `.env`     — the upstream vars, merged, never clobbering yours. Adding
 *                   one means `bun run dev` has to be restarted, since `--hot`
 *                   does not reload process env.
 *   2. ClickHouse — the container the Monitor tab queries, then its seed.
 *   3. mocks      — the MCP app server.
 *   4. seeds      — the project, board, assets and the MCP app connection,
 *                   against the dev home this workspace is actually running.
 *
 * Run (from the repo root, with `bun run dev` already up):
 *   bun run scripts/dev-fixtures.ts [--org=<slug>] [--detach] [--env-only]
 *                                   [--home=<dev home slug>]
 *
 * Without `--detach` it stays in the foreground owning the mock server —
 * the fixture is only alive while it is.
 */

import { spawn, spawnSync, type ChildProcess } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { basename, join } from "path";
import { sleep } from "../packages/shared/src/std";

const args = new Map(
  process.argv
    .slice(2)
    .filter((a) => a.startsWith("--"))
    .map((a) => {
      const [k, v = "true"] = a.slice(2).split("=");
      return [k, v] as const;
    }),
);

const ORG = args.get("org");
const HOME = args.get("home");
const DETACH = args.get("detach") === "true";
const ENV_ONLY = args.get("env-only") === "true";
const REPO_ROOT = new URL("..", import.meta.url).pathname;

const MCP_APP_PORT = 8789;
const CLICKHOUSE_PORT = 8123;
const CLICKHOUSE_CONTAINER = "deco-monitor-clickhouse";

const ENV_BLOCK: [key: string, value: string, comment?: string][] = [
  [
    "CLICKHOUSE_ANALYTICS_ADDRESS",
    `http://localhost:${CLICKHOUSE_PORT}`,
    "Monitor — scripts/dev-monitor-seed.ts",
  ],
  ["CLICKHOUSE_ANALYTICS_USERNAME", "admin_monitor"],
  ["CLICKHOUSE_ANALYTICS_PASSWORD", "dev-monitor"],
];

const step = (msg: string) => console.log(`\n\x1b[1m${msg}\x1b[0m`);
const ok = (msg: string) => console.log(`  ✓ ${msg}`);
const warn = (msg: string) => console.log(`  ! ${msg}`);

// --- 1. env ------------------------------------------------------------------

/** Adds only the keys that are missing, so a real upstream you pointed at
 *  stays pointed at. Returns the keys it wrote. */
function ensureEnv(): string[] {
  const path = join(REPO_ROOT, ".env");
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  const has = (key: string) =>
    new RegExp(`^\\s*${key}\\s*=`, "m").test(current);

  const missing = ENV_BLOCK.filter(([key]) => !has(key));
  if (missing.length === 0) return [];

  const lines: string[] = [""];
  for (const [key, value, comment] of missing) {
    if (comment) lines.push(`# ${comment}`);
    lines.push(`${key}=${value}`);
  }
  writeFileSync(
    path,
    (current.endsWith("\n") || current === "" ? current : `${current}\n`) +
      `${lines.join("\n")}\n`,
  );
  return missing.map(([key]) => key);
}

// --- 2. clickhouse -----------------------------------------------------------

async function portAnswers(port: number, path = "/"): Promise<boolean> {
  try {
    await fetch(`http://localhost:${port}${path}`);
    return true;
  } catch {
    return false;
  }
}

function docker(...argv: string[]) {
  return spawnSync("docker", argv, { encoding: "utf8" });
}

async function ensureClickhouse(): Promise<boolean> {
  if (await portAnswers(CLICKHOUSE_PORT, "/ping")) {
    ok("clickhouse already answering");
    return true;
  }
  if (docker("version").status !== 0) {
    warn("docker not available — Monitor will show its unconfigured state");
    return false;
  }
  const known = docker(
    "ps",
    "-a",
    "--filter",
    `name=^${CLICKHOUSE_CONTAINER}$`,
    "--format",
    "{{.Names}}",
  ).stdout.trim();
  const started = known
    ? docker("start", CLICKHOUSE_CONTAINER)
    : docker(
        "run",
        "-d",
        "--name",
        CLICKHOUSE_CONTAINER,
        "-p",
        `${CLICKHOUSE_PORT}:8123`,
        "-e",
        "CLICKHOUSE_USER=admin_monitor",
        "-e",
        "CLICKHOUSE_PASSWORD=dev-monitor",
        "clickhouse/clickhouse-server:24.8",
      );
  if (started.status !== 0) {
    warn(`could not start clickhouse: ${started.stderr.trim()}`);
    return false;
  }
  for (let i = 0; i < 60; i++) {
    if (await portAnswers(CLICKHOUSE_PORT, "/ping")) {
      ok(`clickhouse up (${known ? "restarted" : "created"})`);
      return true;
    }
    await sleep(1000);
  }
  warn("clickhouse did not answer in 60s");
  return false;
}

// --- 3. mock servers ---------------------------------------------------------

function run(script: string, scriptArgs: string[] = []): ChildProcess {
  return spawn(
    "bun",
    ["run", join(REPO_ROOT, "scripts", script), ...scriptArgs],
    {
      stdio: "inherit",
      detached: DETACH,
    },
  );
}

async function ensureMock(
  script: string,
  port: number,
  children: ChildProcess[],
): Promise<void> {
  if (await portAnswers(port, "/health")) {
    ok(`${script} already on :${port}`);
    return;
  }
  const child = run(script);
  if (DETACH) child.unref();
  else children.push(child);
  for (let i = 0; i < 30; i++) {
    await sleep(300);
    if (await portAnswers(port, "/health")) {
      ok(`${script} on :${port}`);
      return;
    }
  }
  warn(`${script} did not answer on :${port}`);
}

// --- 4. the dev home this workspace is running -------------------------------

interface ServiceState {
  port: number;
}

/**
 * `bun run dev` gives each worktree its own home under the temp dir, keyed by
 * the workspace it runs in, and writes a `state.json` per service with the port
 * it grabbed. Reading those beats grepping `ps` for a port: a machine runs one
 * of these per open workspace, and the newest is not necessarily this one.
 */
function devHome(): string | null {
  const ps = spawnSync("ps", ["ax", "-o", "command"], { encoding: "utf8" });
  const homes = new Set<string>();
  for (const line of ps.stdout.split("\n")) {
    const match = line.match(/-D (\S*decocms-dev-[^/]+)\/services\/postgres/);
    if (match?.[1]) homes.add(match[1]);
  }
  if (homes.size === 0) return null;
  if (HOME) {
    const picked = [...homes].find(
      (h) => h === HOME || h.endsWith(`decocms-dev-${HOME}`),
    );
    if (picked) return picked;
    warn(`no dev home matches --home=${HOME}: ${[...homes].join(", ")}`);
    return null;
  }
  if (homes.size === 1) return [...homes][0]!;

  /** The slug is the worktree's own directory name; the branch is the fallback
   *  for a plain clone, with its `owner/` prefix stripped the way the path is. */
  const branch = spawnSync("git", ["branch", "--show-current"], {
    encoding: "utf8",
    cwd: REPO_ROOT,
  }).stdout.trim();
  const candidates = [
    basename(REPO_ROOT.replace(/\/$/, "")),
    branch,
    branch.split("/").pop() ?? "",
  ]
    .filter(Boolean)
    .map((c) => c.replace(/[^a-zA-Z0-9._-]/g, "-"));

  for (const slug of candidates) {
    const mine = [...homes].find((h) => h.endsWith(`decocms-dev-${slug}`));
    if (mine) return mine;
  }
  warn(
    `several dev homes running and none is ${candidates.join(" / ")} — pick one with --home=<slug>: ${[...homes].join(", ")}`,
  );
  return null;
}

function servicePort(home: string, service: string): number | null {
  const path = join(home, "services", service, "state.json");
  if (!existsSync(path)) return null;
  try {
    const state = JSON.parse(readFileSync(path, "utf8")) as ServiceState;
    return typeof state.port === "number" ? state.port : null;
  } catch {
    return null;
  }
}

function seed(script: string, env: Record<string, string>, extra: string[]) {
  const result = spawnSync(
    "bun",
    ["run", join(REPO_ROOT, "scripts", script), ...extra],
    { stdio: "inherit", env: { ...process.env, ...env } },
  );
  if (result.status !== 0) warn(`${script} exited with ${result.status}`);
}

// --- run ---------------------------------------------------------------------

async function main() {
  step("1. .env");
  const written = ensureEnv();
  if (written.length === 0) {
    ok("upstream vars already set");
  } else {
    ok(`added ${written.join(", ")}`);
    warn("restart `bun run dev` — --hot does not reload process env");
  }
  if (ENV_ONLY) return;

  step("2. clickhouse (Monitor)");
  if (await ensureClickhouse()) {
    seed("dev-monitor-seed.ts", {}, []);
  }

  step("3. mock upstreams");
  const children: ChildProcess[] = [];
  await ensureMock("dev-mcp-app.ts", MCP_APP_PORT, children);

  step("4. seeds");
  const home = devHome();
  if (!home) {
    warn("no `bun run dev` found — start it, then re-run this script");
    return;
  }
  const pg = servicePort(home, "postgres");
  if (!pg) {
    warn(`no postgres state in ${home}`);
    return;
  }
  const minio = servicePort(home, "minio");
  ok(`dev home ${home} (postgres ${pg}${minio ? `, minio ${minio}` : ""})`);

  const orgArg = ORG ? [`--org=${ORG}`] : [];
  const dbEnv = {
    DATABASE_URL: `postgresql://postgres:postgres@localhost:${pg}/postgres`,
  };
  seed(
    "dev-seed-demo-project.ts",
    minio ? { ...dbEnv, S3_ENDPOINT: `http://127.0.0.1:${minio}` } : dbEnv,
    orgArg,
  );
  seed("dev-seed-mcp-app-connection.ts", dbEnv, orgArg);

  if (children.length === 0) return;
  step("mock servers are mine to keep alive — ctrl-c to stop them");
  const stop = () => {
    for (const child of children) child.kill();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await new Promise(() => {});
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
