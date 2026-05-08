import { spawn } from "node:child_process";

/**
 * Best-effort copy of `text` to the system clipboard. Returns true on success,
 * false if the platform tool is missing or fails. Never throws.
 */
export function copyToClipboard(text: string): Promise<boolean> {
  let command: string;
  let args: string[] = [];
  switch (process.platform) {
    case "darwin":
      command = "pbcopy";
      break;
    case "win32":
      command = "clip";
      break;
    case "linux":
      command = "xclip";
      args = ["-selection", "clipboard"];
      break;
    default:
      return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    try {
      const child = spawn(command, args, { stdio: "pipe" });
      child.on("error", () => resolve(false));
      child.on("close", (code) => resolve(code === 0));
      child.stdin.write(text);
      child.stdin.end();
    } catch {
      resolve(false);
    }
  });
}
