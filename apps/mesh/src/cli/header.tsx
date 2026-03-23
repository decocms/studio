import { Box, Text } from "ink";
import { Spinner } from "@inkjs/ui";
import pkg from "../../package.json" with { type: "json" };

export interface ServiceStatus {
  name: string;
  status: "pending" | "ready";
  port: number;
}

interface HeaderProps {
  services: ServiceStatus[];
  migrationsStatus: "pending" | "done";
  home: string;
  serverUrl: string | null;
  vibe?: boolean;
}

const ASCII_LINES = [
  " ██████████   ██████████   █████████     ███████   ",
  "░░███░░░░███ ░░███░░░░░█  ███░░░░░███  ███░░░░░███ ",
  " ░███   ░░███ ░███  █ ░  ███     ░░░  ███     ░░███",
  " ░███    ░███ ░██████   ░███         ░███      ░███",
  " ░███    ░███ ░███░░█   ░███         ░███      ░███",
  " ░███    ███  ░███ ░   █░░███     ███░░███     ███ ",
  " ██████████   ██████████ ░░█████████  ░░░███████░  ",
  "░░░░░░░░░░   ░░░░░░░░░░   ░░░░░░░░░     ░░░░░░░   ",
];

const GRADIENT_COLORS = [
  "#00ff64",
  "#00ee5e",
  "#00dc56",
  "#00c84e",
  "#00b444",
  "#00a03c",
  "#008832",
  "#006e28",
];

function StatusIndicator({ status }: { status: "pending" | "ready" | "done" }) {
  if (status === "pending") {
    return <Spinner label="" />;
  }
  return <Text color="green">{"\u2713"}</Text>;
}

export function Header({
  services,
  migrationsStatus,
  home,
  serverUrl,
  vibe,
}: HeaderProps) {
  return (
    <Box flexDirection="column" paddingBottom={1}>
      <Box flexDirection="column">
        {ASCII_LINES.map((line, i) => (
          <Text key={i} color={GRADIENT_COLORS[i]}>
            {line}
          </Text>
        ))}
        <Text dimColor> v{pkg.version}</Text>
      </Box>

      <Box marginTop={1}>
        <Text dimColor>Home: {home}</Text>
      </Box>

      <Box gap={2}>
        {services.map((svc) => (
          <Box key={svc.name} gap={1}>
            <Text>
              {svc.name} :{svc.port || "...."}
            </Text>
            <StatusIndicator status={svc.status} />
          </Box>
        ))}
        <Box gap={1}>
          <Text>Migrations</Text>
          <StatusIndicator status={migrationsStatus} />
        </Box>
      </Box>

      <Box>
        {serverUrl ? (
          <Text>
            Open in browser: <Text color="cyan">{serverUrl}</Text>
          </Text>
        ) : (
          <Text dimColor>Starting...</Text>
        )}
      </Box>

      <Box gap={2}>
        <Text dimColor>
          <Text bold dimColor>
            K
          </Text>{" "}
          toggle config
        </Text>
        <Text dimColor>
          <Text bold dimColor>
            L
          </Text>{" "}
          toggle log flow
        </Text>
        <Text dimColor>
          <Text bold dimColor>
            V
          </Text>{" "}
          toggle vibe {vibe ? "♪ Nihilore · CC BY 4.0" : ""}
        </Text>
      </Box>
    </Box>
  );
}
