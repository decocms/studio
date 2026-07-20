export class PortInUseError extends Error {
  readonly code = "EADDRINUSE";

  constructor(readonly port: number) {
    super(`Port ${port} is already in use.`);
    this.name = "PortInUseError";
  }
}

export function isAddressInUseError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EADDRINUSE"
  );
}

export function portTerminationCommand(
  port: number,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") {
    return `for /f "tokens=5" %P in ('netstat -ano ^| findstr /R /C:":${port} .*LISTENING"') do taskkill /F /PID %P`;
  }

  return `kill -9 $(lsof -ti tcp:${port})`;
}

export function formatPortInUseMessage(
  port: number,
  platform: NodeJS.Platform = process.platform,
): string {
  return [
    `Port ${port} is already in use.`,
    "Run this command to stop the process listening on it, then retry `decocms link`:",
    "",
    `  ${portTerminationCommand(port, platform)}`,
  ].join("\n");
}
