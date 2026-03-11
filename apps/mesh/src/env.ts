import { homedir } from "os";
import { join } from "path";
import { z } from "zod";

const zBooleanString = z
  .enum(["true", "false", "1", "0", ""])
  .optional()
  .transform((v) => v === "true" || v === "1");

const envSchema = z
  .object({
    // Core
    NODE_ENV: z
      .enum(["production", "development", "test"])
      .default("development"),
    PORT: z.coerce.number().default(3000),
    BASE_URL: z.string().optional(),
    DATA_DIR: z.string().default(join(homedir(), "deco")),

    // Database
    DATABASE_URL: z.string().optional(), // default derived from DATA_DIR via .transform
    DATABASE_PG_SSL: zBooleanString,

    // Auth & Secrets
    BETTER_AUTH_SECRET: z.string().default(""),
    ENCRYPTION_KEY: z.string().default(""),
    MESH_JWT_SECRET: z.string().optional(),
    MESH_LOCAL_MODE: zBooleanString,
    MESH_ALLOW_LOCAL_PROD: zBooleanString,
    DISABLE_RATE_LIMIT: zBooleanString,

    // Observability
    CLICKHOUSE_URL: z.string().optional(),
    OTEL_SERVICE_NAME: z.string().default("mesh"),

    // Event Bus & Networking
    NATS_URL: z.string().optional(),
    NOTIFY_STRATEGY: z.enum(["nats", "postgres", "polling"]).optional(),

    // Config files
    CONFIG_PATH: z.string().default("./config.json"),
    AUTH_CONFIG_PATH: z.string().default("./auth-config.json"),

    // Transport
    UNSAFE_ALLOW_STDIO_TRANSPORT: zBooleanString,

    // Debug / K8s
    DEBUG_PORT: z.coerce.number().default(9090),
    ENABLE_DEBUG_SERVER: zBooleanString,
    PRESTOP_HEAP_SNAPSHOT_DIR: z.string().optional(),
    POD_NAME: z.string().optional(),
    HOSTNAME: z.string().optional(),
  })
  .transform((e) => ({
    ...e,
    DATABASE_URL: e.DATABASE_URL ?? `file://${join(e.DATA_DIR, "db.pglite")}`,
  }));

export type Env = z.infer<typeof envSchema>;

const result = envSchema.safeParse(process.env);

if (!result.success) {
  console.error("Invalid environment configuration:");
  console.error(result.error.format());
  process.exit(1);
}

export const env: Env = result.data;

// Log active configuration (redact secrets)
function redactUrl(url: string | undefined): string {
  if (!url) return "not set";
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = "***";
    if (parsed.username && parsed.username.length > 3)
      parsed.username = parsed.username.slice(0, 3) + "***";
    return parsed.toString();
  } catch {
    if (url.length <= 10) return url;
    return url.slice(0, 6) + "***" + url.slice(-4);
  }
}

const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
const green = (s: string) => `\x1b[32m${s}\x1b[39m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[39m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[39m`;

const SECRET_KEYS = new Set([
  "BETTER_AUTH_SECRET",
  "ENCRYPTION_KEY",
  "MESH_JWT_SECRET",
]);
const URL_KEYS = new Set(["DATABASE_URL", "CLICKHOUSE_URL", "NATS_URL"]);

function formatValue(key: string, raw: unknown): string {
  if (SECRET_KEYS.has(key)) {
    return raw ? dim("●●●●●●") : dim("not set");
  }
  if (URL_KEYS.has(key)) {
    const redacted = redactUrl(raw as string | undefined);
    return redacted === "not set" ? dim(redacted) : cyan(redacted);
  }
  if (raw === undefined || raw === null || raw === "") return dim("not set");
  const str = String(raw);
  if (str === "true") return green(str);
  if (str === "false") return yellow(str);
  try {
    new URL(str);
    return cyan(str);
  } catch {
    return str;
  }
}

function logConfiguration(e: Env) {
  const KEY_WIDTH = 32;
  const RULE_WIDTH = 42;
  const lines: string[] = [];

  const section = (title: string) => {
    lines.push("");
    lines.push(
      `  ${dim(`── ${title} ${"─".repeat(Math.max(0, RULE_WIDTH - title.length - 4))}`)}`,
    );
  };

  const row = (key: string, value: unknown) => {
    lines.push(`  ${dim(key.padEnd(KEY_WIDTH))}${formatValue(key, value)}`);
  };

  lines.push("");
  lines.push("  Mesh Configuration");

  section("Core");
  row("NODE_ENV", e.NODE_ENV);
  row("PORT", e.PORT);
  row("BASE_URL", e.BASE_URL ?? `http://localhost:${e.PORT}`);
  row("DATA_DIR", e.DATA_DIR);

  section("Database");
  row("DATABASE_URL", e.DATABASE_URL);
  row("DATABASE_PG_SSL", e.DATABASE_PG_SSL);

  section("Auth & Secrets");
  row("BETTER_AUTH_SECRET", e.BETTER_AUTH_SECRET);
  row("ENCRYPTION_KEY", e.ENCRYPTION_KEY);
  row("MESH_JWT_SECRET", e.MESH_JWT_SECRET);
  row("MESH_LOCAL_MODE", e.MESH_LOCAL_MODE);
  row("MESH_ALLOW_LOCAL_PROD", e.MESH_ALLOW_LOCAL_PROD);
  row("DISABLE_RATE_LIMIT", e.DISABLE_RATE_LIMIT);

  section("Observability");
  row("CLICKHOUSE_URL", e.CLICKHOUSE_URL);
  row("OTEL_SERVICE_NAME", e.OTEL_SERVICE_NAME);

  section("Event Bus & Networking");
  row("NATS_URL", e.NATS_URL);
  row("NOTIFY_STRATEGY", e.NOTIFY_STRATEGY ?? "auto");

  section("Config Files");
  row("CONFIG_PATH", e.CONFIG_PATH);
  row("AUTH_CONFIG_PATH", e.AUTH_CONFIG_PATH);

  section("Transport");
  row("UNSAFE_ALLOW_STDIO_TRANSPORT", e.UNSAFE_ALLOW_STDIO_TRANSPORT);

  section("Debug / K8s");
  row("DEBUG_PORT", e.DEBUG_PORT);
  row("ENABLE_DEBUG_SERVER", e.ENABLE_DEBUG_SERVER);
  row("PRESTOP_HEAP_SNAPSHOT_DIR", e.PRESTOP_HEAP_SNAPSHOT_DIR);
  row("POD_NAME", e.POD_NAME);
  row("HOSTNAME", e.HOSTNAME);

  lines.push("");
  console.log(lines.join("\n"));
}

logConfiguration(env);
