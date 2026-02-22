/**
 * scanner.ts
 *
 * Public scanner API for discovering Deco block and loader definitions from a project folder.
 *
 * Block identification:
 * - Files must have `export default` in their content (quick text pre-filter, then AST)
 * - Files in `sections/` folder path → kind: 'section'
 * - Files in `loaders/` folder path → kind: 'loader'
 * - Files with `export default` elsewhere → kind: 'block'
 *
 * Error policy: If schema extraction fails, errors are propagated with added context.
 * Callers must handle or fix type resolution failures — no partial schemas are returned.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import type { Schema } from "ts-json-schema-generator";
import {
  extractPropsSchema,
  extractReturnTypeSchema,
} from "./schema-extractor.ts";

// ============================================================================
// Public types
// ============================================================================

/**
 * A Deco block, section, or generic component definition.
 * All definitions include a JSON Schema for their configurable props.
 */
export interface BlockDefinition {
  /** File stem (e.g., "ProductShelf") */
  name: string;
  /** Absolute path to the source file */
  filePath: string;
  /** Discriminated type: sections live in sections/, loaders in loaders/, everything else is block */
  kind: "section" | "loader" | "block";
  /** JSON Schema for the component's Props type (may be {} if the component has no configurable props) */
  propsSchema: Schema;
}

/**
 * A Deco loader definition. Extends BlockDefinition with a return type schema.
 * Loaders fetch data and their return type is consumed by sections.
 */
export interface LoaderDefinition extends BlockDefinition {
  kind: "loader";
  /** JSON Schema for the loader's return type (unwrapped from Promise<T>) */
  returnType: Schema;
}

// ============================================================================
// Internal helpers
// ============================================================================

/** Directories to exclude from scanning. */
const EXCLUDED_DIRS = new Set(["node_modules", "dist", ".deco", ".git"]);

/**
 * Find the nearest `tsconfig.json` starting from `startDir`, walking up the directory
 * tree up to `maxLevels` parent directories. Throws if not found.
 */
function findTsConfig(startDir: string, maxLevels = 3): string {
  let current = startDir;
  for (let i = 0; i <= maxLevels; i++) {
    const candidate = path.join(current, "tsconfig.json");
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      // Reached filesystem root
      break;
    }
    current = parent;
  }
  throw new Error(
    `Could not find tsconfig.json at or above ${startDir} (checked ${maxLevels + 1} levels)`,
  );
}

/**
 * Determine the block kind from the file path.
 */
function getKind(filePath: string): "section" | "loader" | "block" {
  if (filePath.includes("/sections/") || filePath.includes("\\sections\\")) {
    return "section";
  }
  if (filePath.includes("/loaders/") || filePath.includes("\\loaders\\")) {
    return "loader";
  }
  return "block";
}

/**
 * Check if a path segment should be excluded from scanning.
 */
function isExcluded(filePath: string): boolean {
  const parts = filePath.split(/[/\\]/);
  return parts.some((part) => EXCLUDED_DIRS.has(part));
}

/**
 * Quick check: does the file content contain `export default`?
 * Uses string search before doing any AST work — fast pre-filter.
 */
async function hasExportDefault(filePath: string): Promise<boolean> {
  try {
    const text = await Bun.file(filePath).text();
    // Match "export default" as a standalone token (not inside a string/comment ideally,
    // but for a pre-filter this fast check is acceptable — false positives are then
    // caught by the schema extractor which does proper AST parsing)
    return /\bexport\s+default\b/.test(text);
  } catch {
    return false;
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Scan a project root for all block and section definitions.
 *
 * Walks the project folder using Bun's native Glob, filters to files with
 * `export default`, and returns their block definitions with JSON Schema for props.
 *
 * @param projectRoot - Absolute path to the deco project root
 * @returns Array of BlockDefinition objects (sections, loaders, and generic blocks)
 * @throws If tsconfig.json is not found at or above the project root
 * @throws If a file's props type cannot be fully resolved (must-be-complete-or-throw policy)
 */
export async function scanBlocks(
  projectRoot: string,
): Promise<BlockDefinition[]> {
  // Step 1: Locate tsconfig.json (walk up from projectRoot)
  const tsConfigPath = findTsConfig(projectRoot);

  // Step 2: Use Bun's native Glob for recursive TypeScript file discovery
  const glob = new Bun.Glob("**/*.{ts,tsx}");
  const definitions: BlockDefinition[] = [];

  for await (const relativePath of glob.scan(projectRoot)) {
    const filePath = path.join(projectRoot, relativePath);

    // Step 3a: Exclude blacklisted directories
    if (isExcluded(relativePath)) {
      continue;
    }

    // Step 3b: Quick pre-filter — only process files with `export default`
    if (!(await hasExportDefault(filePath))) {
      continue;
    }

    // Step 4: Determine kind from folder path
    const kind = getKind(filePath);

    // Step 4: Extract props schema — propagate errors with context
    let propsSchema: Schema;
    try {
      propsSchema = extractPropsSchema(filePath, tsConfigPath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to extract props from ${filePath}: ${message}`);
    }

    // Build the definition
    const name = path.basename(filePath, path.extname(filePath));
    definitions.push({
      name,
      filePath,
      kind,
      propsSchema,
    });
  }

  return definitions;
}

/**
 * Scan a project root for all loader definitions.
 *
 * Loaders live in the `loaders/` folder. This function calls `scanBlocks()` to
 * discover all files, filters to loaders, and adds their return type schema.
 *
 * @param projectRoot - Absolute path to the deco project root
 * @returns Array of LoaderDefinition objects with propsSchema and returnType
 * @throws If tsconfig.json is not found at or above the project root
 * @throws If a loader's types cannot be fully resolved
 */
export async function scanLoaders(
  projectRoot: string,
): Promise<LoaderDefinition[]> {
  // Step 1: Get all block definitions (includes loaders)
  const all = await scanBlocks(projectRoot);

  // Step 2: Filter to loaders only
  const loaderBlocks = all.filter((b) => b.kind === "loader");

  if (loaderBlocks.length === 0) {
    return [];
  }

  // Step 3: Need tsconfig path for return type extraction (re-locate)
  const tsConfigPath = findTsConfig(projectRoot);

  // Step 4: Add returnType to each loader
  const loaders: LoaderDefinition[] = [];

  for (const block of loaderBlocks) {
    let returnType: Schema;
    try {
      returnType = extractReturnTypeSchema(block.filePath, tsConfigPath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Failed to extract return type from ${block.filePath}: ${message}`,
      );
    }

    loaders.push({
      ...block,
      kind: "loader",
      returnType,
    });
  }

  return loaders;
}
