import { Box, Text } from "ink";
import type { Env } from "../env";

const SECRET_KEYS = new Set([
  "BETTER_AUTH_SECRET",
  "ENCRYPTION_KEY",
  "MESH_JWT_SECRET",
]);

const URL_KEYS = new Set(["DATABASE_URL", "CLICKHOUSE_URL", "NATS_URL"]);

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

function formatValue(
  key: string,
  raw: unknown,
): { text: string; color?: string; dimColor?: boolean } {
  if (SECRET_KEYS.has(key)) {
    return raw
      ? { text: "\u25cf\u25cf\u25cf\u25cf\u25cf\u25cf", dimColor: true }
      : { text: "not set", dimColor: true };
  }
  if (URL_KEYS.has(key)) {
    const redacted = redactUrl(raw as string | undefined);
    return redacted === "not set"
      ? { text: redacted, dimColor: true }
      : { text: redacted, color: "cyan" };
  }
  if (raw === undefined || raw === null || raw === "")
    return { text: "not set", dimColor: true };
  const str = String(raw);
  if (str === "true") return { text: str, color: "green" };
  if (str === "false") return { text: str, color: "yellow" };
  try {
    new URL(str);
    return { text: str, color: "cyan" };
  } catch {
    return { text: str };
  }
}

interface ConfigSection {
  title: string;
  entries: { key: string; value: unknown }[];
}

function getConfigSections(e: Env): ConfigSection[] {
  return [
    {
      title: "Core",
      entries: [
        { key: "NODE_ENV", value: e.NODE_ENV },
        { key: "PORT", value: e.PORT },
        { key: "BASE_URL", value: e.BASE_URL ?? `http://localhost:${e.PORT}` },
        { key: "DATA_DIR", value: e.DATA_DIR },
      ],
    },
    {
      title: "Database",
      entries: [
        { key: "DATABASE_URL", value: e.DATABASE_URL },
        { key: "DATABASE_PG_SSL", value: e.DATABASE_PG_SSL },
      ],
    },
    {
      title: "Auth & Secrets",
      entries: [
        { key: "BETTER_AUTH_SECRET", value: e.BETTER_AUTH_SECRET },
        { key: "ENCRYPTION_KEY", value: e.ENCRYPTION_KEY },
        { key: "MESH_JWT_SECRET", value: e.MESH_JWT_SECRET },
        { key: "DECOCMS_LOCAL_MODE", value: e.DECOCMS_LOCAL_MODE },
        { key: "DECOCMS_ALLOW_LOCAL_PROD", value: e.DECOCMS_ALLOW_LOCAL_PROD },
        { key: "DISABLE_RATE_LIMIT", value: e.DISABLE_RATE_LIMIT },
      ],
    },
    {
      title: "Observability",
      entries: [
        { key: "CLICKHOUSE_URL", value: e.CLICKHOUSE_URL },
        { key: "OTEL_SERVICE_NAME", value: e.OTEL_SERVICE_NAME },
      ],
    },
    {
      title: "Event Bus & Networking",
      entries: [{ key: "NATS_URL", value: e.NATS_URL }],
    },
    {
      title: "Config Files",
      entries: [
        { key: "CONFIG_PATH", value: e.CONFIG_PATH },
        { key: "AUTH_CONFIG_PATH", value: e.AUTH_CONFIG_PATH },
      ],
    },
    {
      title: "Transport",
      entries: [
        {
          key: "UNSAFE_ALLOW_STDIO_TRANSPORT",
          value: e.UNSAFE_ALLOW_STDIO_TRANSPORT,
        },
      ],
    },
    {
      title: "AI Gateway",
      entries: [
        { key: "DECO_AI_GATEWAY_ENABLED", value: e.DECO_AI_GATEWAY_ENABLED },
        { key: "DECO_AI_GATEWAY_URL", value: e.DECO_AI_GATEWAY_URL },
      ],
    },
  ];
}

interface ConfigViewProps {
  env: Env;
}

export function ConfigView({ env: e }: ConfigViewProps) {
  const sections = getConfigSections(e);

  return (
    <Box flexDirection="column">
      {sections.map((section) => (
        <Box key={section.title} flexDirection="column" marginTop={1}>
          <Text dimColor>
            {"  "}── {section.title}{" "}
            {"─".repeat(Math.max(0, 38 - section.title.length))}
          </Text>
          {section.entries.map(({ key, value }) => {
            const formatted = formatValue(key, value);
            return (
              <Box key={key}>
                <Text dimColor>
                  {"  "}
                  {key.padEnd(32)}
                </Text>
                <Text
                  color={formatted.color as never}
                  dimColor={formatted.dimColor}
                >
                  {formatted.text}
                </Text>
              </Box>
            );
          })}
        </Box>
      ))}
    </Box>
  );
}
