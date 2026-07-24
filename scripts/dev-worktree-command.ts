import { join } from "path";

interface BuildDevCommandOptions {
  repoRoot: string;
  slug: string;
  port: number;
  vitePort: number;
  extraArgs: string[];
  tmpRoot: string;
}

function hasExplicitHome(args: string[]): boolean {
  return args.some((arg) => arg === "--home" || arg.startsWith("--home="));
}

function safePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-");
}

export function buildDevCommand(options: BuildDevCommandOptions): string[] {
  const homeArgs = hasExplicitHome(options.extraArgs)
    ? []
    : [join(options.tmpRoot, `decocms-dev-${safePathSegment(options.slug)}`)];

  return [
    "bun",
    "run",
    join(options.repoRoot, "apps/api/src/cli.ts"),
    "dev",
    "--port",
    String(options.port),
    "--vite-port",
    String(options.vitePort),
    "--base-url",
    `http://${options.slug}.localhost`,
    ...(homeArgs.length > 0 ? ["--home", ...homeArgs] : []),
    ...options.extraArgs,
  ];
}
