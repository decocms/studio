#!/usr/bin/env bun
import { readFileSync } from "fs";
import { join } from "path";
import { startWorktree } from "worktree-devservers";

function loadDotEnv(path: string): Record<string, string> {
  try {
    const result: Record<string, string> = {};
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx === -1) continue;
      const key = trimmed.slice(0, idx).trim();
      const val = trimmed
        .slice(idx + 1)
        .trim()
        .replace(/^["']|["']$/g, "");
      result[key] = val;
    }
    return result;
  } catch {
    return {};
  }
}

const slug = process.env.WORKTREE_SLUG;
if (!slug) {
  console.error("❌ WORKTREE_SLUG environment variable is required.");
  process.exit(1);
}

startWorktree(slug, async (ctx) => {
  const port = await ctx.findFreePort(3000);
  const vitePort = await ctx.findFreePort(4000);

  console.log(`🔌 ${ctx.slug}.localhost → Hono :${port}, Vite :${vitePort}`);

  const repoRoot = join(import.meta.dir, "..");
  const dotEnv = loadDotEnv(join(repoRoot, "apps/mesh/.env"));

  const child = Bun.spawn(["bun", "run", "--cwd=apps/mesh", "dev"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...dotEnv,
      PORT: String(port),
      VITE_PORT: String(vitePort),
      BASE_URL: `http://${ctx.slug}.localhost`,
    },
    stdio: ["inherit", "inherit", "inherit"],
  });

  return { port, process: child };
}).catch((e) => {
  console.error("dev:worktree error:", e);
  process.exit(1);
});
