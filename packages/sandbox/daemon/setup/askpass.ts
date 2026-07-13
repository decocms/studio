import { chmod, mkdir, writeFile } from "node:fs/promises";
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
  // Clone is the FIRST setup step — logsDir may not exist yet on a fresh
  // boot (nothing else has written a log there at that point), so create it
  // rather than assuming a LogTee beat us to it. Caught by the daemon e2e
  // suite: writeFile ENOENT'd and every clone failed.
  await mkdir(dir, { recursive: true });
  await writeFile(path, spec.content, "utf8");
  if (process.platform !== "win32") await chmod(path, 0o755);
  return path;
}
