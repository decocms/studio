export type PackageManager = "npm" | "pnpm" | "yarn" | "bun" | "deno";

export type VMRuntime = "node" | "bun" | "deno";

export const PACKAGE_MANAGER_CONFIG: Record<
  PackageManager,
  {
    install: string;
    run: (script: string) => string;
    runtime: VMRuntime;
  }
> = {
  npm: {
    install: "npm install",
    run: (s) => `npm run ${s}`,
    runtime: "node",
  },
  pnpm: {
    install: "pnpm install",
    run: (s) => `pnpm run ${s}`,
    runtime: "node",
  },
  yarn: {
    install: "yarn install",
    run: (s) => `yarn run ${s}`,
    runtime: "node",
  },
  bun: {
    install: "bun install",
    run: (s) => `bun run ${s}`,
    runtime: "bun",
  },
  deno: {
    install: "deno install",
    run: (s) => `deno task ${s}`,
    runtime: "deno",
  },
};
