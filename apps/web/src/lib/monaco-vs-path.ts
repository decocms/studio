import monacoPackage from "monaco-editor/package.json" with { type: "json" };

/**
 * Where this app serves the Monaco editor engine from — its OWN origin, never
 * a CDN. Imported by BOTH halves: `vite.config.ts`'s `self-hosted-monaco`
 * plugin serves these files, `components/monaco/loader.ts` requests them. A
 * plain module rather than a build-time `define` so it also resolves under
 * `bun test`, which applies no Vite config.
 *
 * Carries the engine version because the filenames underneath are NOT
 * content-hashed: it is what lets a deploy serve them `immutable`
 * (`deploy/helm/studio/files/api-nginx.conf`) without pinning a browser to
 * whichever engine it cached first.
 *
 * MUST keep `/vs` as its last segment. Monaco's worker bootstrap
 * (`min/vs/base/worker/workerMain.js`) resolves its AMD base as the literal
 * `"../../../"` relative to itself — three levels up from
 * `<path>/base/worker/` — and then loads module ids that all start with `vs/`.
 * Rename the segment and the editor still mounts while every language worker
 * 404s. `loader.test.ts` pins this.
 */
export const MONACO_VS_PATH = `/monaco/${monacoPackage.version}/vs`;
