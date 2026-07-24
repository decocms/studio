#!/usr/bin/env bun
/**
 * Migration Index Generator
 *
 * Automatically generates the migrations/index.ts file by scanning
 * the migrations folder for all migration files.
 *
 * Usage:
 *   bun run src/generate-migrations.ts
 */

import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Sanitizes a string to create a valid JavaScript identifier.
 * - Replaces all non-alphanumeric characters with underscores
 * - Prefixes with "_" if the result starts with a digit
 * - Normalizes consecutive underscores to a single underscore
 * - Trims to a safe length (max 100 characters)
 */
function sanitizeIdentifier(name: string): string {
  // Replace all non-alphanumeric characters with underscores
  let sanitized = name.replace(/[^a-zA-Z0-9]/g, "_");

  // Normalize consecutive underscores to a single underscore
  sanitized = sanitized.replace(/_+/g, "_");

  // Remove leading/trailing underscores
  sanitized = sanitized.replace(/^_+|_+$/g, "");

  // If it starts with a digit, prefix with "_"
  if (/^\d/.test(sanitized)) {
    sanitized = `_${sanitized}`;
  }

  // Trim to a safe length (max 100 characters)
  if (sanitized.length > 100) {
    sanitized = sanitized.substring(0, 100);
  }

  // Ensure it's not empty (fallback to "_migration" if empty)
  if (!sanitized) {
    sanitized = "_migration";
  }

  return sanitized;
}

async function generateMigrationsIndex() {
  console.log("🔍 Scanning migrations folder...");

  const migrationsDir = join(import.meta.dirname, "../migrations");
  const files = await readdir(migrationsDir);

  // Filter for migration files (exclude index.ts and non-ts files)
  const migrationFiles = files
    .filter((file) => file.endsWith(".ts") && file !== "index.ts")
    .sort();

  console.log(`📦 Found ${migrationFiles.length} migration files:`);
  migrationFiles.forEach((file) => console.log(`   - ${file}`));

  // Generate imports
  const imports = migrationFiles
    .map((file) => {
      const name = file.replace(".ts", "");
      const varName = sanitizeIdentifier(name);
      return `import * as migration${varName} from "./${file}";`;
    })
    .join("\n");

  // Generate migrations object
  const entries = migrationFiles
    .map((file) => {
      const name = file.replace(".ts", "");
      const varName = sanitizeIdentifier(name);
      return `  "${name}": migration${varName},`;
    })
    .join("\n");

  // Generate the full file content
  const content = `import { type Migration } from "kysely";
${imports}

const migrations = {
${entries}
} satisfies Record<string, Migration>;

export default migrations;
`;

  // Write to migrations/index.ts
  const outputPath = join(migrationsDir, "index.ts");
  await writeFile(outputPath, content, "utf-8");

  console.log("\n✅ Generated migrations/index.ts successfully!");
  console.log(`📝 Path: ${outputPath}`);
}

// Run the generator
generateMigrationsIndex()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("❌ Failed to generate migrations index:", error);
    process.exit(1);
  });
