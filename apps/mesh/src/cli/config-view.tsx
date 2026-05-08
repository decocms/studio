import { Box, Text } from "ink";
import type { Settings } from "../settings";

const SECRET_KEYS = new Set([
  "BETTER_AUTH_SECRET",
  "ENCRYPTION_KEY",
  "MESH_JWT_SECRET",
  "STUDIO_PROVISION_SECRET_KEY",
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
    if (Array.isArray(raw)) {
      if (raw.length === 0) return { text: "not set", dimColor: true };
      const redacted = raw.map((u) => redactUrl(u as string)).join(", ");
      return { text: redacted, color: "cyan" };
    }
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

function getConfigSections(e: Settings): ConfigSection[] {
  return [
    {
      title: "Core",
      entries: [
        { key: "NODE_ENV", value: e.nodeEnv },
        { key: "PORT", value: e.port },
        { key: "BASE_URL", value: e.baseUrl ?? `http://localhost:${e.port}` },
        { key: "DATA_DIR", value: e.dataDir },
      ],
    },
    {
      title: "Database",
      entries: [
        { key: "DATABASE_URL", value: e.databaseUrl },
        { key: "DATABASE_PG_SSL", value: e.databasePgSsl },
      ],
    },
    {
      title: "Auth & Secrets",
      entries: [
        { key: "BETTER_AUTH_SECRET", value: e.betterAuthSecret },
        { key: "ENCRYPTION_KEY", value: e.encryptionKey },
        { key: "MESH_JWT_SECRET", value: e.meshJwtSecret },
        {
          key: "STUDIO_PROVISION_SECRET_KEY",
          value: e.studioProvisionSecretKey,
        },
        { key: "DISABLE_RATE_LIMIT", value: e.disableRateLimit },
      ],
    },
    {
      title: "Auth Providers",
      entries: [
        {
          key: "AUTH_EMAIL_PASSWORD_ENABLED",
          value: process.env.AUTH_EMAIL_PASSWORD_ENABLED ?? "true",
        },
        {
          key: "AUTH_GOOGLE_CLIENT_ID",
          value: !!process.env.AUTH_GOOGLE_CLIENT_ID,
        },
        {
          key: "AUTH_GITHUB_CLIENT_ID",
          value: !!process.env.AUTH_GITHUB_CLIENT_ID,
        },
        {
          key: "AUTH_RESEND_API_KEY",
          value: !!process.env.AUTH_RESEND_API_KEY,
        },
        {
          key: "AUTH_SENDGRID_API_KEY",
          value: !!process.env.AUTH_SENDGRID_API_KEY,
        },
        {
          key: "AUTH_SSO_MS_CLIENT_ID",
          value: !!process.env.AUTH_SSO_MS_CLIENT_ID,
        },
        {
          key: "AUTH_SSO_GOOGLE_CLIENT_ID",
          value: !!process.env.AUTH_SSO_GOOGLE_CLIENT_ID,
        },
        {
          key: "AUTH_MAGIC_LINK_ENABLED",
          value: process.env.AUTH_MAGIC_LINK_ENABLED === "true",
        },
        {
          key: "AUTH_EMAIL_OTP_ENABLED",
          value: process.env.AUTH_EMAIL_OTP_ENABLED === "true",
        },
      ],
    },
    {
      title: "Observability",
      entries: [
        { key: "CLICKHOUSE_URL", value: e.clickhouseUrl },
        { key: "OTEL_SERVICE_NAME", value: e.otelServiceName },
      ],
    },
    {
      title: "Event Bus & Networking",
      entries: [{ key: "NATS_URL", value: e.natsUrls }],
    },
    {
      title: "Config Files",
      entries: [{ key: "CONFIG_PATH", value: e.configPath }],
    },
    {
      title: "AI Gateway",
      entries: [
        { key: "DECO_AI_GATEWAY_ENABLED", value: e.aiGatewayEnabled },
        { key: "DECO_AI_GATEWAY_URL", value: e.aiGatewayUrl },
      ],
    },
  ];
}

interface ConfigViewProps {
  env: Settings;
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
                  {key.padEnd(36)}
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
