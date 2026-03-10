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
    BETTER_AUTH_SECRET: z.string().min(1),
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

console.log(
  "Mesh configuration:",
  JSON.stringify(
    {
      NODE_ENV: env.NODE_ENV,
      PORT: env.PORT,
      BASE_URL: env.BASE_URL ?? `http://localhost:${env.PORT}`,
      DATA_DIR: env.DATA_DIR,
      DATABASE_URL: redactUrl(env.DATABASE_URL),
      CLICKHOUSE_URL: redactUrl(env.CLICKHOUSE_URL),
      NATS_URL: redactUrl(env.NATS_URL),
      OTEL_SERVICE_NAME: env.OTEL_SERVICE_NAME,
      MESH_LOCAL_MODE: env.MESH_LOCAL_MODE,
      NOTIFY_STRATEGY: env.NOTIFY_STRATEGY ?? "auto",
    },
    null,
    2,
  ),
);
