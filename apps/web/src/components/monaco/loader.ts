import { loader } from "@monaco-editor/react";
import type { Environment } from "monaco-editor";
import { MONACO_VS_PATH } from "@/lib/monaco-vs-path";

/**
 * Monaco's worker entry point, which the language services (TypeScript
 * diagnostics, JSON validation) and the diff computation run in.
 *
 * Declaring it matters as much as pointing the loader at our own origin:
 * left undeclared, monaco's AMD loader wraps every worker in a `blob:` URL,
 * and the packaged shell's `worker-src` — absent, so inherited from
 * `script-src 'self'` — refuses that just as flatly as it refuses a CDN.
 * Given an explicit URL, monaco constructs the worker from it directly.
 */
const MONACO_WORKER_PATH = `${MONACO_VS_PATH}/base/worker/workerMain.js`;

/**
 * Points `@monaco-editor/loader` at the engine this app serves itself, rather
 * than the CDN it defaults to (currently a DIFFERENT monaco version), and
 * declares where its workers live.
 *
 * Must run before any `<Editor>` mounts — the first `loader.init()` latches
 * the path, and later `config()` calls are silently ignored. `./editor.ts` is
 * what guarantees that ordering; import `Editor`/`DiffEditor` from there and
 * this is already done.
 */
export function configureMonacoLoader() {
  loader.config({ paths: { vs: MONACO_VS_PATH } });
  const monacoEnvironment: Environment = {
    ...globalThis.MonacoEnvironment,
    getWorkerUrl: () => MONACO_WORKER_PATH,
  };
  globalThis.MonacoEnvironment = monacoEnvironment;
}
