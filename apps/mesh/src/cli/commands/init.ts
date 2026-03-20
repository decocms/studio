/**
 * `deco init <directory>` — scaffold a new MCP app from decocms/mcp-app template.
 */
import { existsSync, readdirSync } from "fs";

export async function initCommand(directory?: string): Promise<void> {
  const targetDir = directory || ".";

  // Check if directory exists and is non-empty
  if (existsSync(targetDir)) {
    const entries = readdirSync(targetDir);
    if (entries.length > 0) {
      console.log(`Directory "${targetDir}" is not empty.`);
      console.log("Use an empty directory or a new directory name to proceed.");
      process.exit(1);
    }
  }

  console.log(`Scaffolding new MCP app into ${targetDir}...`);

  // Use degit to clone without git history
  try {
    // @ts-expect-error degit has no type declarations
    const degit = (await import("degit")).default;
    const emitter = degit("decocms/mcp-app", { cache: false, force: true });
    await emitter.clone(targetDir);
  } catch {
    // Fallback: try git clone + remove .git
    console.log("degit not available, falling back to git clone...");
    const proc = Bun.spawn(
      [
        "git",
        "clone",
        "--depth=1",
        "https://github.com/decocms/mcp-app.git",
        targetDir,
      ],
      { stdout: "inherit", stderr: "inherit" },
    );
    const code = await proc.exited;
    if (code !== 0) {
      console.error("Failed to clone template repository.");
      process.exit(1);
    }
    // Remove .git directory
    const { rm } = await import("fs/promises");
    const { join } = await import("path");
    await rm(join(targetDir, ".git"), { recursive: true, force: true });
  }

  // Install dependencies
  console.log("\nInstalling dependencies...");
  const install = Bun.spawn(["bun", "install"], {
    cwd: targetDir,
    stdout: "inherit",
    stderr: "inherit",
  });
  await install.exited;

  // Print next steps
  console.log("\nDone! Next steps:");
  console.log("");
  if (targetDir !== ".") {
    console.log(`  cd ${targetDir}`);
  }
  console.log("  bunx decocms");
  console.log("");
}
