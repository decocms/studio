// @ts-check
import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";
import { unlink } from "node:fs/promises";
import { join } from "node:path";

import mdx from "@astrojs/mdx";

import react from "@astrojs/react";

/**
 * Patches the CSR redirect to delete the root index files.
 * @returns {import("astro").AstroIntegration}
 */
function patchCsrRedirect() {
  return {
    name: "patch-csr-redirect",
    hooks: {
      "astro:build:done": async ({ dir }) => {
        const filesToDelete = [
          "index.html",
          "en/index.html",
          "pt-br/index.html",
        ];
        for (const file of filesToDelete) {
          try {
            await unlink(join(dir.pathname, file));
            console.log(`[CSR Redirect Patch] Deleted ${file}`);
          } catch {
            // File may not exist, ignore
          }
        }
      },
    },
  };
}

// https://astro.build/config
export default defineConfig({
  root: "client",
  server: {
    port: 4000,
  },
  redirects: {
    "/": "/2026-03-10/en/mcp-mesh/quickstart",
  },
  outDir: "dist/client/",
  srcDir: "client/src",
  integrations: [mdx(), react(), patchCsrRedirect()],
  vite: {
    plugins: [
      // @ts-ignore: tailwindcss plugin type issue
      tailwindcss(),
    ],
    server: {
      hmr: {
        clientPort: 4000,
      },
    },
  },
  markdown: {
    shikiConfig: {
      themes: {
        light: "github-light",
        dark: "github-dark",
      },
      defaultColor: "light",
    },
  },
});
