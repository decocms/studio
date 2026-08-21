import { loader } from "@monaco-editor/react";

/**
 * Path this app serves the Monaco engine from — its OWN origin, never a CDN.
 *
 * `@monaco-editor/loader` fetches the engine at runtime by appending a
 * `<script src="{paths.vs}/loader.js">` to the document. The packaged desktop
 * shell serves the UI under `script-src 'self'`
 * (`apps/native/src-tauri/tauri.conf.json5`), so a CDN src is refused; the
 * loader has no fallback (`loaderScript.onerror` just rejects `init()`), and
 * `<Editor>` renders its `loading` prop forever — a file whose contents already
 * arrived shows as a permanent spinner. Same-origin also keeps the editor
 * working offline and off a third-party host in the hot path.
 *
 * The path is defined by the `self-hosted-monaco` plugin in
 * `apps/web/vite.config.ts`, which is also what serves the files.
 */
const MONACO_VS_PATH = __MONACO_VS_PATH__;

/**
 * Monaco's own default worker URL, which the language services (TypeScript
 * diagnostics, JSON validation) and the diff computation run in.
 *
 * Declaring it matters as much as the path above: left undefined, monaco's AMD
 * loader wraps every worker in a `blob:` URL, which `worker-src` — falling back
 * to `default-src 'self'` — refuses just as flatly as it refuses the CDN.
 * Given an explicit URL, monaco constructs the worker from it directly. The
 * worker then resolves its own AMD base relative to its location, so the
 * language services load from this same directory.
 */
const MONACO_WORKER_PATH = `${MONACO_VS_PATH}/base/worker/workerMain.js`;

type MonacoWorkerEnvironment = { getWorkerUrl: () => string };

/**
 * Call at module scope from every module that renders `<Editor>`: the first
 * `loader.init()` wins, so this has to run before anything mounts.
 * Idempotent — repeat calls set the same values.
 */
export function configureMonacoLoader() {
  loader.config({ paths: { vs: MONACO_VS_PATH } });
  (
    globalThis as { MonacoEnvironment?: MonacoWorkerEnvironment }
  ).MonacoEnvironment = { getWorkerUrl: () => MONACO_WORKER_PATH };
}
