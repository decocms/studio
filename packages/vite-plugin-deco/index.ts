import type { Plugin } from "vite";
import process from "process";
import path from "path";
import { exec } from "child_process";
import fs from "fs/promises";
import { cloudflare } from "@cloudflare/vite-plugin";

const VITE_SERVER_ENVIRONMENT_NAME = "server";

interface PluginConfig {
  target?: "cloudflare" | "bun";
  port?: number;
  experimentalAutoGenerateTypes?: boolean;
}

const cwd = process.cwd();
const DEFAULT_PORT = 4000;
const CF_DEFAULT_PORT = 8787;
const GEN_PROMISE_KEY = "deco-gen";

const GEN_FILE = "deco.gen.ts";

async function performDecoGen() {
  // @ts-ignore
  const cmd = typeof Bun === "undefined" ? "npm run gen" : "bun run gen";
  exec(cmd, { cwd }, (error) => {
    if (error) {
      console.error(`Error performing deco gen: ${error}`);
    }
  });
}

function shouldPerformDecoGen({ filePath }: { filePath: string }): boolean {
  return filePath.startsWith("server/") && !filePath.endsWith(GEN_FILE);
}

const FILES_TO_REMOVE = [
  ".dev.vars",
  // TODO: Support source maps
  "index.js.map",
];

const RENAME_MAP = {
  "index.js": "main.js",
};

type Operation =
  | {
      type: "remove";
      file: string;
    }
  | {
      type: "rename";
      oldFile: string;
      newFile: string;
    }
  | {
      type: "modify";
      file: string;
      replace: (content: string) => string;
    };

const OPERATIONS: Operation[] = [
  ...FILES_TO_REMOVE.map((file) => ({
    type: "remove" as const,
    file,
  })),
  ...Object.entries(RENAME_MAP).map(([oldFile, newFile]) => ({
    type: "rename" as const,
    oldFile,
    newFile,
  })),
];

async function fixCloudflareBuild({
  outputDirectory,
}: {
  outputDirectory: string;
}) {
  const files = await fs.readdir(outputDirectory);

  const isCloudflareViteBuild = files.some((file) => file === "wrangler.json");

  if (!isCloudflareViteBuild) {
    return;
  }

  const results = await Promise.allSettled(
    OPERATIONS.map(async (operation) => {
      if (operation.type === "remove") {
        await fs.rm(path.join(outputDirectory, operation.file), {
          force: true,
        });
      } else if (operation.type === "rename") {
        await fs.rename(
          path.join(outputDirectory, operation.oldFile),
          path.join(outputDirectory, operation.newFile),
        );
      }
    }),
  );

  results.forEach((result) => {
    if (result.status === "rejected") {
      console.error(`Error performing operation: ${result.reason}`);
    }
  });
}

export function decoCloudflarePatchPlugin(): Plugin {
  let outputDirectory = "dist";

  return {
    name: "vite-plugin-deco",
    enforce: "post",
    configResolved(config) {
      outputDirectory = config.build.outDir || "dist";
    },
    async closeBundle() {
      await fixCloudflareBuild({ outputDirectory });
    },
    config: () => ({
      worker: {
        format: "es",
      },
      optimizeDeps: {
        force: true,
      },
      build: {
        sourcemap: true,
      },
      define: {
        // Ensure proper module definitions for Cloudflare Workers context
        "process.env.NODE_ENV": JSON.stringify(
          process.env.NODE_ENV || "development",
        ),
        global: "globalThis",
      },
    }),
  };
}

export function importSqlStringPlugin(): Plugin {
  return {
    name: "vite-plugin-import-sql-string",
    transform(content: string, id: string) {
      if (id.endsWith(".sql")) {
        return {
          code: `export default ${JSON.stringify(content)};`,
          map: null,
        };
      }
    },
  };
}

export function decoGenPlugin(decoConfig: PluginConfig = {}): Plugin {
  const singleFlight = new Map<string, Promise<void>>();

  return {
    name: "vite-plugin-deco-gen",
    buildStart() {
      if (!decoConfig.experimentalAutoGenerateTypes) {
        return;
      }
      performDecoGen();
    },
    handleHotUpdate(ctx) {
      // skip hmr entirely for the deco gen file
      if (ctx.file.endsWith(GEN_FILE)) {
        return [];
      }
      if (!decoConfig.experimentalAutoGenerateTypes) {
        return ctx.modules;
      }
      const relative = path.relative(cwd, ctx.file);
      if (!shouldPerformDecoGen({ filePath: relative })) {
        return ctx.modules;
      }
      const promise = singleFlight.get(GEN_PROMISE_KEY);
      if (promise) {
        return ctx.modules;
      }
      const newPromise = performDecoGen().finally(() => {
        singleFlight.delete(GEN_PROMISE_KEY);
      });
      singleFlight.set(GEN_PROMISE_KEY, newPromise);
      return ctx.modules;
    },
  };
}

export function baseDecoPlugin(decoConfig: PluginConfig = {}): Plugin {
  const buildOutDir =
    decoConfig.target === "cloudflare" ? "dist" : "dist/client";

  return {
    name: "vite-plugin-base-deco",
    config: () => ({
      server: {
        port:
          decoConfig.port ||
          parseInt(process.env.VITE_PORT || "", 10) ||
          DEFAULT_PORT,
        strictPort: true,
      },
      build: {
        outDir: buildOutDir,
      },
    }),
  };
}

export default function vitePlugins(decoConfig: PluginConfig = {}): Plugin[] {
  const targets: Record<NonNullable<PluginConfig["target"]>, Plugin[]> = {
    cloudflare: [
      ...cloudflare({
        configPath: "wrangler.toml",
        viteEnvironment: {
          name: VITE_SERVER_ENVIRONMENT_NAME,
        },
      }),
      decoCloudflarePatchPlugin(),
      baseDecoPlugin({
        ...decoConfig,
        port: decoConfig.port || CF_DEFAULT_PORT,
      }),
      decoGenPlugin(decoConfig),
      importSqlStringPlugin(),
    ],
    bun: [baseDecoPlugin(decoConfig), decoGenPlugin(decoConfig)],
  };

  const plugins = targets[decoConfig.target || "cloudflare"];

  if (!plugins) {
    throw new Error(`Unsupported target: ${decoConfig.target}`);
  }

  return plugins;
}
