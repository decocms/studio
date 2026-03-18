import inquirer from "inquirer";
import { promises as fs } from "fs";
import { spawn } from "child_process";
import { join } from "path";
import { ensureDir, copy } from "../../lib/fs.js";
import { slugify } from "../../lib/slugify.js";
import { displayBanner } from "../../lib/banner.js";
import process from "node:process";

interface Template {
  name: string;
  description: string;
  repo: string;
  branch?: string;
  pathsToIgnore?: string[];
}

const DEFAULT_TEMPLATE: Template = {
  name: "MCP App",
  description: "MCP App template for deco",
  repo: "decocms/mcp-app",
  branch: "main",
  pathsToIgnore: [],
};

function runCommand(
  command: string,
  args: string[],
  cwd?: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    const process = spawn(command, args, {
      cwd,
      stdio: "pipe",
    });

    process.on("close", (code) => {
      resolve(code === 0);
    });

    process.on("error", () => {
      resolve(false);
    });
  });
}

const PATHS_TO_IGNORE_ALWAYS = [".git"];

async function downloadTemplate(
  template: Template,
  targetDir: string,
): Promise<void> {
  const tempDir = join(process.cwd(), `.temp-${Date.now()}`);

  try {
    const success = await runCommand("git", [
      "clone",
      "--depth",
      "1",
      "--branch",
      template.branch || "main",
      `https://github.com/${template.repo}.git`,
      tempDir,
    ]);

    if (!success) {
      throw new Error(`Failed to clone template repository: ${template.repo}`);
    }

    const pathsToIgnore = [
      ...(template.pathsToIgnore || []),
      ...PATHS_TO_IGNORE_ALWAYS,
    ];

    for (const path of pathsToIgnore) {
      try {
        const pathToRemove = join(tempDir, path);
        const isDirectory = await fs
          .stat(pathToRemove)
          .then((stat) => stat.isDirectory());
        await fs.rm(
          pathToRemove,
          isDirectory ? { recursive: true, force: true } : { force: true },
        );
      } catch {
        console.warn(`Failed to remove ${path} from the original template`);
      }
    }

    await ensureDir(targetDir);
    await copy(tempDir, targetDir, { overwrite: true });

    console.log(`✅ Template '${template.name}' downloaded successfully!`);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function customizeTemplate({
  targetDir,
  projectName,
}: {
  targetDir: string;
  projectName: string;
}): Promise<void> {
  // Update package.json name
  const packageJsonPath = join(targetDir, "package.json");
  try {
    const packageJsonContent = await fs.readFile(packageJsonPath, "utf-8");
    const packageJson = JSON.parse(packageJsonContent);
    packageJson.name = projectName;
    await fs.writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2));
  } catch (error) {
    console.warn(
      "⚠️  Could not customize package.json:",
      error instanceof Error ? error.message : String(error),
    );
  }

  // Update app.json name and scopeName
  const appJsonPath = join(targetDir, "app.json");
  try {
    const appJsonContent = await fs.readFile(appJsonPath, "utf-8");
    const appJson = JSON.parse(appJsonContent);
    appJson.name = projectName;
    appJson.scopeName = projectName;
    await fs.writeFile(appJsonPath, JSON.stringify(appJson, null, 2));
  } catch (error) {
    console.warn(
      "⚠️  Could not customize app.json:",
      error instanceof Error ? error.message : String(error),
    );
  }
}

export async function createCommand(projectName?: string): Promise<void> {
  try {
    console.clear();
    displayBanner();

    const selectedTemplate = DEFAULT_TEMPLATE;

    const finalProjectName = slugify(
      projectName ||
        (
          await inquirer.prompt([
            {
              type: "input",
              name: "projectName",
              message: "Enter project name:",
              validate: (value: string) => {
                if (!value.trim()) {
                  return "Project name cannot be empty";
                }
                if (!/^[a-z0-9-]+$/.test(value)) {
                  return "Project name can only contain lowercase letters, numbers, and hyphens";
                }
                return true;
              },
            },
          ])
        ).projectName,
    );

    const targetDir = join(process.cwd(), finalProjectName);
    try {
      await fs.access(targetDir);

      const { overwrite } = await inquirer.prompt([
        {
          type: "list",
          name: "overwrite",
          message: `Directory '${finalProjectName}' already exists. Overwrite?`,
          choices: ["No", "Yes"],
        },
      ]);

      if (overwrite === "No") {
        console.log("❌ Project creation cancelled.");
        return;
      }

      await fs.rm(targetDir, { recursive: true });
    } catch {
      // Directory doesn't exist, that's fine
    }

    console.log(`📦 Downloading template '${selectedTemplate.name}'...`);
    await downloadTemplate(selectedTemplate, targetDir);

    await customizeTemplate({
      targetDir,
      projectName: finalProjectName,
    });

    // Initialize git repo
    try {
      const success = await runCommand("git", ["init"], targetDir);
      if (success) {
        console.log(`✅ Git repository initialized in '${finalProjectName}'`);
      } else {
        console.warn("⚠️  Failed to initialize git repository");
      }
    } catch (error) {
      console.warn(
        "⚠️  Could not initialize git repository:",
        error instanceof Error ? error.message : String(error),
      );
    }

    console.log(`\n🎉 Project '${finalProjectName}' created successfully!`);
    console.log(`\nNext steps:`);
    console.log(`  cd ${finalProjectName}`);
    console.log(`  bun install`);
    console.log(`  bun run dev`);
  } catch (error) {
    console.error(
      "❌ Failed to create project:",
      error instanceof Error ? error.message : String(error),
    );
    process.exit(1);
  }
}
