import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";

export function askpassSpec(platform: NodeJS.Platform): {
  filename: string;
  content: string;
} {
  if (platform === "win32") {
    return { filename: "askpass.bat", content: "@exit /b 0\r\n" };
  }
  return { filename: "askpass.sh", content: "#!/bin/sh\nexit 0\n" };
}

/**
 * Writes the platform's no-op askpass into `dir` and returns its absolute
 * path. Called once at orchestrator config time (boot path — the one place
 * a small await'd write is fine); idempotent by content.
 */
export async function materializeAskpass(dir: string): Promise<string> {
  const spec = askpassSpec(process.platform);
  const path = join(dir, spec.filename);
  await writeFile(path, spec.content, "utf8");
  if (process.platform !== "win32") await chmod(path, 0o755);
  return path;
}
