import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const ROOT = process.env.DECOPILOT_DEBUG_LOG_DIR;

export function makeStepDebugLogger(runKey: string) {
  if (!ROOT) return undefined;
  const dir = join(ROOT, runKey);
  let step = 0;
  let mkdirP: Promise<unknown> | undefined;
  return async (snapshot: unknown) => {
    mkdirP ??= mkdir(dir, { recursive: true });
    await mkdirP;
    const n = String(++step).padStart(3, "0");
    await writeFile(
      join(dir, `step-${n}.json`),
      JSON.stringify(snapshot, null, 2),
    );
  };
}
