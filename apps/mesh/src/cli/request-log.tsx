import { Box, Text } from "ink";
import type { LogEntry } from "./log-emitter";

function statusColor(status: number): string {
  if (status >= 500) return "red";
  if (status >= 400) return "yellow";
  if (status >= 300) return "cyan";
  return "green";
}

export function RequestLog({ logs }: { logs: LogEntry[] }) {
  return (
    <Box flexDirection="column">
      {logs.map((entry, i) => {
        if (entry.rawLine) {
          return (
            <Text key={i} dimColor>
              {entry.rawLine}
            </Text>
          );
        }

        const durationStr =
          entry.duration < 1000
            ? `${entry.duration}ms`
            : `${(entry.duration / 1000).toFixed(1)}s`;

        return (
          <Text key={i}>
            <Text dimColor>
              {entry.method.padEnd(6)} {entry.path.padEnd(30)}{" "}
            </Text>
            <Text color={statusColor(entry.status)}>{entry.status}</Text>
            <Text dimColor> {durationStr.padStart(8)}</Text>
          </Text>
        );
      })}
    </Box>
  );
}
