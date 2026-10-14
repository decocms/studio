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

/** A DNS label for `<slug>.localhost`: Conductor workspace names may carry spaces and capitals. */
export function worktreeHostSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 63)
    .replace(/-$/, "");
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
