#!/usr/bin/env bun
/**
 * Like dev-worktree.ts but spawns `dev:local` instead of `dev`.
 * Routes http://<WORKTREE_SLUG>.localhost → local-mode dev server.
 */
import { join } from "path";
import { startWorktree } from "worktree-devservers";

const slug = process.env.WORKTREE_SLUG;
if (!slug) {
  console.error("WORKTREE_SLUG environment variable is required.");
  process.exit(1);
}

startWorktree(slug, async (ctx) => {
  const port = await ctx.findFreePort(3000);
  const vitePort = await ctx.findFreePort(4000);

  console.log(`${ctx.slug}.localhost → Hono :${port}, Vite :${vitePort}`);

  const repoRoot = join(import.meta.dir, "..");

  const child = Bun.spawn(["bun", "run", "--cwd=apps/mesh", "dev:local"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      VITE_PORT: String(vitePort),
      BASE_URL: `http://${ctx.slug}.localhost`,
    },
    stdio: ["inherit", "inherit", "inherit"],
  });

  return { port, process: child };
}).catch((e) => {
  console.error("dev:local:worktree error:", e);
  process.exit(1);
});
