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
    NATS_URL: z.string().default("nats://localhost:4222"),

    // Config files
    CONFIG_PATH: z.string().default("./config.json"),
    AUTH_CONFIG_PATH: z.string().default("./auth-config.json"),

    // Transport
    UNSAFE_ALLOW_STDIO_TRANSPORT: zBooleanString,

    // AI Gateway
    DECO_AI_GATEWAY_ENABLED: zBooleanString,
    DECO_AI_GATEWAY_URL: z.string().default("https://ai-site.decocache.com"),

    // Feature Flags
    ENABLE_DECO_IMPORT: zBooleanString,

    // Object Storage (S3-compatible)
    S3_ENDPOINT: z.string().optional(),
    S3_BUCKET: z.string().optional(),
    S3_REGION: z.string().default("auto"),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),
    S3_FORCE_PATH_STYLE: z
      .enum(["true", "false", "1", "0", ""])
      .optional()
      .transform(
        (v) => v === undefined || v === "" || v === "true" || v === "1",
      ),

    // Debug / K8s
    DEBUG_PORT: z.coerce.number().default(9090),
    ENABLE_DEBUG_SERVER: zBooleanString,
    PRESTOP_HEAP_SNAPSHOT_DIR: z.string().optional(),
    POD_NAME: z.string().optional(),
    HOSTNAME: z.string().optional(),
  })
  .transform((e) => ({
    ...e,
    DATABASE_URL:
      e.DATABASE_URL ??
      "postgresql://postgres:postgres@localhost:5432/postgres",
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
    parsed.pathname = "/";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    if (url.length <= 10) return url;
    return url.slice(0, 6) + "***" + url.slice(-4);
  }
}

import { KEY_WIDTH, RULE_WIDTH, cyan, dim, green, yellow } from "./fmt";

const SECRET_KEYS = new Set([
  "BETTER_AUTH_SECRET",
  "ENCRYPTION_KEY",
  "MESH_JWT_SECRET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
]);
const URL_KEYS = new Set([
  "DATABASE_URL",
  "CLICKHOUSE_URL",
  "NATS_URL",
  "S3_ENDPOINT",
]);

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
  const lines: string[] = [];

  const sect = (title: string) => {
    lines.push("");
    lines.push(
      `  ${dim(`── ${title} ${"─".repeat(Math.max(0, RULE_WIDTH - title.length - 4))}`)}`,
    );
  };

  const r = (key: string, value: unknown) => {
    lines.push(`  ${dim(key.padEnd(KEY_WIDTH))}${formatValue(key, value)}`);
  };

  sect("Core");
  r("NODE_ENV", e.NODE_ENV);
  r("PORT", e.PORT);
  r("BASE_URL", e.BASE_URL ?? `http://localhost:${e.PORT}`);
  r("DATA_DIR", e.DATA_DIR);

  sect("Database");
  r("DATABASE_URL", e.DATABASE_URL);
  r("DATABASE_PG_SSL", e.DATABASE_PG_SSL);

  sect("Auth & Secrets");
  r("BETTER_AUTH_SECRET", e.BETTER_AUTH_SECRET);
  r("ENCRYPTION_KEY", e.ENCRYPTION_KEY);
  r("MESH_JWT_SECRET", e.MESH_JWT_SECRET);
  r("MESH_LOCAL_MODE", e.MESH_LOCAL_MODE);
  r("MESH_ALLOW_LOCAL_PROD", e.MESH_ALLOW_LOCAL_PROD);
  r("DISABLE_RATE_LIMIT", e.DISABLE_RATE_LIMIT);

  sect("Observability");
  r("CLICKHOUSE_URL", e.CLICKHOUSE_URL);
  r("OTEL_SERVICE_NAME", e.OTEL_SERVICE_NAME);

  sect("Event Bus & Networking");
  r("NATS_URL", e.NATS_URL);

  sect("Config Files");
  r("CONFIG_PATH", e.CONFIG_PATH);
  r("AUTH_CONFIG_PATH", e.AUTH_CONFIG_PATH);

  sect("Transport");
  r("UNSAFE_ALLOW_STDIO_TRANSPORT", e.UNSAFE_ALLOW_STDIO_TRANSPORT);

  sect("AI Gateway");
  r("DECO_AI_GATEWAY_ENABLED", e.DECO_AI_GATEWAY_ENABLED);
  r("DECO_AI_GATEWAY_URL", e.DECO_AI_GATEWAY_URL);

  sect("Feature Flags");
  r("ENABLE_DECO_IMPORT", e.ENABLE_DECO_IMPORT);

  sect("Object Storage");
  r("S3_ENDPOINT", e.S3_ENDPOINT);
  r("S3_BUCKET", e.S3_BUCKET);
  r("S3_REGION", e.S3_REGION);
  r("S3_ACCESS_KEY_ID", e.S3_ACCESS_KEY_ID);
  r("S3_SECRET_ACCESS_KEY", e.S3_SECRET_ACCESS_KEY);
  r("S3_FORCE_PATH_STYLE", e.S3_FORCE_PATH_STYLE);

  sect("Debug / K8s");
  r("DEBUG_PORT", e.DEBUG_PORT);
  r("ENABLE_DEBUG_SERVER", e.ENABLE_DEBUG_SERVER);
  r("PRESTOP_HEAP_SNAPSHOT_DIR", e.PRESTOP_HEAP_SNAPSHOT_DIR);
  r("POD_NAME", e.POD_NAME);
  r("HOSTNAME", e.HOSTNAME);

  lines.push("");
  console.log(lines.join("\n"));
}

export { logConfiguration };
