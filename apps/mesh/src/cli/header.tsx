import { Box, Text } from "ink";
import { Spinner } from "@inkjs/ui";
import { useSyncExternalStore } from "react";
import pkg from "../../package.json" with { type: "json" };
import { getCapyFrame, subscribeCapyFrame } from "./capy-animation";
import { getMatrixGrid, subscribeMatrixGrid } from "./matrix-rain";

export interface ServiceStatus {
  name: string;
  status: "pending" | "ready";
  port: number;
}

export interface HeaderAutostartProject {
  name: string;
  status: "starting" | "ready" | "failed";
  chatUrl: string | null;
  error?: string;
}

interface HeaderProps {
  services: ServiceStatus[];
  migrationsStatus: "pending" | "done";
  home: string;
  serverUrl: string | null;
  vibe?: boolean;
  autostartProject?: HeaderAutostartProject | null;
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

// Green gradient pairs for capybara rows (light body, dark body)
const CAPY_GRADIENT: [string, string][] = [
  ["#00ff64", "#00cc50"],
  ["#00f060", "#00c04c"],
  ["#00e05c", "#00b448"],
  ["#00d058", "#00a844"],
  ["#00c054", "#009c40"],
  ["#00b050", "#00903c"],
  ["#00a04c", "#008438"],
  ["#009048", "#007834"],
  ["#008044", "#006c30"],
  ["#007040", "#00602c"],
  ["#00603c", "#005428"],
];

// Max visual width of capybara across all animation frames
const CAPY_WIDTH = 30;

const CAPY_BODY_COLORS = new Set(["#875f00", "#5f3800"]);

function greenifyCapyColor(
  color: string | null,
  rowIndex: number,
): string | null {
  if (!color || !CAPY_BODY_COLORS.has(color)) return color;
  const pair =
    CAPY_GRADIENT[rowIndex] ?? CAPY_GRADIENT[CAPY_GRADIENT.length - 1]!;
  return color === "#875f00" ? pair[0] : pair[1];
}

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
  autostartProject,
}: HeaderProps) {
  const capyFrame = useSyncExternalStore(subscribeCapyFrame, getCapyFrame);
  const matrixGrid = useSyncExternalStore(subscribeMatrixGrid, getMatrixGrid);

  return (
    <Box flexDirection="column" paddingBottom={1}>
      {vibe ? (
        <Box flexDirection="column">
          {capyFrame.map((line, i) => {
            const matrixRow = matrixGrid[i];
            const rowWidth = line.reduce(
              (acc, seg) => acc + seg.text.length,
              0,
            );
            const pad = Math.max(0, CAPY_WIDTH - rowWidth);
            return (
              <Box key={i} flexDirection="row">
                {line.map((seg, j) => {
                  const color = greenifyCapyColor(seg.color, i);
                  return color ? (
                    <Text key={j} color={color}>
                      {seg.text}
                    </Text>
                  ) : (
                    <Text key={j}>{seg.text}</Text>
                  );
                })}
                <Text>{" ".repeat(pad + 2)}</Text>
                {matrixRow?.map((cell, k) =>
                  cell.color ? (
                    <Text key={k} color={cell.color}>
                      {cell.char}
                    </Text>
                  ) : (
                    <Text key={k}>{cell.char}</Text>
                  ),
                )}
              </Box>
            );
          })}
          <Text dimColor> v{pkg.version}</Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {ASCII_LINES.map((line, i) => (
            <Text key={i} color={GRADIENT_COLORS[i]}>
              {line}
            </Text>
          ))}
          <Text dimColor> v{pkg.version}</Text>
        </Box>
      )}
      <Box marginBottom={1}>
        <Text dimColor>{"─".repeat(80)}</Text>
      </Box>

      <Box>
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

      {autostartProject && (
        <Box flexDirection="column" marginTop={1}>
          <Box gap={1}>
            <Text color="magenta">▶</Text>
            <Text>Autostart:</Text>
            <Text bold>{autostartProject.name}</Text>
            {autostartProject.status === "starting" && <Spinner label="" />}
            {autostartProject.status === "failed" && (
              <Text color="red">failed</Text>
            )}
            {autostartProject.status === "ready" && (
              <Text color="green">ready</Text>
            )}
          </Box>
          {autostartProject.chatUrl && (
            <Text>
              {"  "}Chat: <Text color="cyan">{autostartProject.chatUrl}</Text>
            </Text>
          )}
          {autostartProject.error && (
            <Text dimColor>
              {"  "}
              {autostartProject.error}
            </Text>
          )}
        </Box>
      )}

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
        {vibe && (
          <Text dimColor>
            <Text bold dimColor>
              N
            </Text>{" "}
            skip song
          </Text>
        )}
      </Box>
    </Box>
  );
}
