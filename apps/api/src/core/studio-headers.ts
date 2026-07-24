export const STUDIO_HEADERS = {
  token: "x-studio-token",
  client: "x-studio-client",
  properties: "x-studio-properties",
  runMetadata: "x-studio-run-metadata",
} as const;

const LEGACY_HEADERS = {
  token: "x-mesh-token",
  client: "x-mesh-client",
  properties: "x-mesh-properties",
  runMetadata: "x-mesh-run-metadata",
} as const satisfies Record<keyof typeof STUDIO_HEADERS, string>;

type StudioHeader = keyof typeof STUDIO_HEADERS;

/** Reads Studio's canonical header first, then its legacy Mesh alias. */
export function readStudioHeader(
  headers: Headers,
  header: StudioHeader,
): string | null {
  return (
    headers.get(STUDIO_HEADERS[header]) ?? headers.get(LEGACY_HEADERS[header])
  );
}

/**
 * Writes both names during the compatibility window so older downstream
 * runtimes continue to receive Studio request context.
 */
export function writeStudioHeader(
  headers: Record<string, string>,
  header: StudioHeader,
  value: string,
): void {
  headers[STUDIO_HEADERS[header]] = value;
  headers[LEGACY_HEADERS[header]] = value;
}
