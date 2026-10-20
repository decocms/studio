/**
 * Smoke test: every JS plugin registered in `.oxlintrc.json` must actually
 * report on code that violates it.
 *
 * This exists because they silently stopped. oxlint's JS plugin support is
 * experimental, and on 1.23.0 a bug inside oxlint's own `Context.report`
 * ("TypeError: Either `node` or `loc` is required") aborted plugins
 * mid-file — non-deterministically, a different set each run, and WITHOUT
 * failing the lint. One run of the fixtures below lost 11 of 12 plugins and
 * `oxlint` still exited 0. Every custom rule in this repo was a coin flip in
 * CI and in the pre-commit hook.
 *
 * A plugin that no-ops looks exactly like a clean codebase, so a passing
 * `bun run lint` proves nothing on its own. Each plugin needs a fixture that
 * MUST produce a diagnostic — that is the only signal that distinguishes the
 * two. Adding a plugin to `.oxlintrc.json` means adding its fixture here; the
 * final test fails if the two lists drift.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readOxlintConfig } from "./read-oxlintrc.ts";

// Each case spawns a real oxlint subprocess; CI runs these alongside the other
// plugin suites, so allow generous headroom over the 5s bun default.
const TIMEOUT = 20_000;

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const TMP = `${ROOT}/.js-plugins-smoke.tmp`;
const CONFIG = `${TMP}/.oxlintrc.json`;

/**
 * plugin name -> a file path (relative to TMP) and a body that violates it.
 * Paths matter: the boundary plugins key off the tree a file sits in.
 */
const FIXTURES: Record<string, { path: string; code: string }> = {
  "enforce-kebab-case-file-names": {
    path: "apps/web/src/NotKebab.tsx",
    code: "export const a = 1;\n",
  },
  "enforce-query-key-constants": {
    path: "apps/web/src/query-key.ts",
    code: 'export const o = { queryKey: ["tool", 1], queryFn: () => 1 };\n',
  },
  "ban-use-effect": {
    path: "apps/web/src/effect.tsx",
    code:
      'import { useEffect } from "react";\n' +
      "export function C() {\n  useEffect(() => {}, []);\n  return null;\n}\n",
  },
  "ban-memoization": {
    path: "apps/web/src/memoization.tsx",
    code:
      'import { useMemo } from "react";\n' +
      "export function C() {\n  return useMemo(() => 1, []);\n}\n",
  },
  "require-cn-classname": {
    path: "apps/web/src/classname.tsx",
    code:
      "export function C({ a }: { a: boolean }) {\n" +
      '  return <div className={a ? "x" : "y"} />;\n}\n',
  },
  "ban-direct-auth-client-organization": {
    path: "apps/web/src/org.ts",
    code:
      'import { authClient } from "./auth";\n' +
      'export const f = () => authClient.organization.setActive({ organizationId: "o" });\n',
  },
  "ban-ref-current-assignment": {
    path: "apps/web/src/ref.tsx",
    code:
      'import { useRef } from "react";\n' +
      "export function C() {\n  const r = useRef(0);\n  r.current = 1;\n  return null;\n}\n",
  },
  "ban-cross-tree-imports": {
    path: "packages/some-pkg/src/cross-tree.ts",
    code: 'import { a } from "@/core/studio-context";\nexport const b = a;\n',
  },
  "ban-e2e-app-imports": {
    path: "packages/e2e/tests/reach-in.test.ts",
    code:
      'import { a } from "../../../apps/api/src/core/studio-context";\n' +
      "export const b = a;\n",
  },
  "ban-web-server-imports": {
    path: "apps/web/src/web-server.ts",
    code:
      'import type { A } from "../../api/src/core/studio-context";\n' +
      "export type B = A;\n",
  },
  "ban-git-provider-reachthrough": {
    path: "apps/api/src/tools/reach-through.ts",
    code: 'import { x } from "@/git-providers/github/client";\nexport const y = x;\n',
  },
  "ensure-tailwind-design-system-tokens": {
    path: "apps/web/src/tokens.tsx",
    code: 'export const C = () => <div className="bg-emerald-600" />;\n',
  },
};

/** The plugins the repo actually enforces, read from the real config. */
const registered: string[] = readOxlintConfig(ROOT).jsPlugins.map((p) =>
  p.replace(/^.*\//, "").replace(/\.js$/, ""),
);

beforeAll(() => {
  rmSync(TMP, { recursive: true, force: true });
  for (const { path, code } of Object.values(FIXTURES)) {
    const abs = `${TMP}/${path}`;
    mkdirSync(abs.slice(0, abs.lastIndexOf("/")), { recursive: true });
    writeFileSync(abs, code);
  }
  // Plugin paths are resolved relative to the config's directory (TMP).
  writeFileSync(
    CONFIG,
    JSON.stringify({
      jsPlugins: Object.keys(FIXTURES).map((n) => `../plugins/${n}.js`),
      rules: Object.fromEntries(
        Object.keys(FIXTURES).map((n) => [`${n}/${ruleOf(n)}`, "error"]),
      ),
      plugins: ["react"],
    }),
  );
});
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

/** Only one plugin names its rule differently from the plugin itself. */
function ruleOf(plugin: string): string {
  return plugin === "enforce-kebab-case-file-names" ? "kebab-case" : plugin;
}

async function lint(): Promise<{ code?: string; message: string }[]> {
  const proc = Bun.spawn(
    ["node_modules/.bin/oxlint", "-c", CONFIG, "-f", "json", TMP],
    { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
  );
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  await proc.exited;
  // Do NOT let a non-JSON stdout surface as a parse error — "No files found"
  // (a fixture path excluded by .gitignore, say) would otherwise look like a
  // broken test rather than a lint that never ran.
  if (!out.trimStart().startsWith("{")) {
    throw new Error(
      `oxlint produced no JSON report.\nstdout: ${out}\nstderr: ${err}`,
    );
  }
  return (
    JSON.parse(out) as { diagnostics: { code?: string; message: string }[] }
  ).diagnostics;
}

test(
  "every JS plugin reports on a file that violates it",
  async () => {
    const diagnostics = await lint();

    // A plugin that throws is reported as a diagnostic with no `code`, and
    // does NOT fail the lint — surface it explicitly or it stays invisible.
    const crashes = diagnostics
      .filter((d) => d.message.startsWith("Error running JS plugin"))
      .map((d) => d.message.split("\n").slice(0, 3).join(" | "));
    expect(crashes).toEqual([]);

    const silent = Object.keys(FIXTURES).filter(
      (plugin) => !diagnostics.some((d) => d.code?.includes(plugin)),
    );
    expect(silent).toEqual([]);
  },
  TIMEOUT,
);

test("every plugin registered in .oxlintrc.json has a fixture here", () => {
  expect(registered.filter((p) => !(p in FIXTURES))).toEqual([]);
});
