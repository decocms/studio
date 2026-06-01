import { Box, Text } from "ink";
import { BANNER_GRADIENT, BANNER_LINES } from "./banner-art";

/** Ink rendering of the shared DECO banner. */
export function Banner({ version }: { version: string }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      {BANNER_LINES.map((line, i) => (
        <Text key={i} color={BANNER_GRADIENT[i]}>
          {line}
        </Text>
      ))}
      <Text dimColor> v{version}</Text>
    </Box>
  );
}
