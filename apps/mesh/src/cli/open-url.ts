/** Best-effort "open this URL in the user's browser" for the link TUI. */
import { spawn } from "node:child_process";

export function resolveOpenCommand(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "open";
  if (platform === "win32") return "start";
  return "xdg-open";
}

export function openPreviewUrl(
  url: string,
  platform: NodeJS.Platform = process.platform,
): void {
  const cmd = resolveOpenCommand(platform);
  try {
    spawn(cmd, [url], { stdio: "ignore", detached: true }).unref();
  } catch {
    // Opening a browser must never crash the TUI.
  }
}
