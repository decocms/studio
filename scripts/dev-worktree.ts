#!/usr/bin/env bun
/**
 * Worktree dev entry point — delegates to the CLI `dev` subcommand with
 * dynamic ports and base URL for multi-tenant localhost.
 *
 * Called by `bun run dev:worktree` / `bun run dev:conductor`.
 */
import { join } from "path";
import { tmpdir } from "os";
import { startWorktree } from "worktree-devservers";
import { buildDevCommand } from "./dev-worktree-command";

const slug = process.env.WORKTREE_SLUG;
if (!slug) {
  console.error("WORKTREE_SLUG environment variable is required.");
  process.exit(1);
}

const repoRoot = join(import.meta.dir, "..");

// Suppress noisy logs from worktree-devservers — they corrupt the Ink TUI
// by writing to stdout while Ink manages cursor-based re-rendering.
const _originalLog = console.log;
console.log = (...args: unknown[]) => {
  const msg = String(args[0] ?? "");
  if (msg.includes("is live") || msg.includes("Cleaned stale route")) return;
  _originalLog(...args);
};

startWorktree(slug, async (ctx) => {
  const port = await ctx.findFreePort(3000);
  const vitePort = await ctx.findFreePort(4000);

  const child = Bun.spawn(
    buildDevCommand({
      repoRoot,
      slug: ctx.slug,
      port,
      vitePort,
      extraArgs: process.argv.slice(2),
      tmpRoot: tmpdir(),
    }),
    { stdio: ["inherit", "inherit", "inherit"] },
  );

  return { port: vitePort, process: child };
}).catch((e) => {
  console.error("dev:worktree error:", e);
  process.exit(1);
});
