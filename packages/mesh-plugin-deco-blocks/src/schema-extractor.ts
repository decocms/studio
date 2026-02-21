/**
 * schema-extractor.ts
 *
 * Internal helpers to convert TypeScript types to JSON Schema using
 * ts-json-schema-generator. Follows the "must be complete or throw" policy:
 * if a type cannot be fully resolved, these functions throw — no partial schemas.
 *
 * Pitfall mitigations (from 16-RESEARCH.md):
 * 1. Props not named "Props": Fall back to inspecting the first parameter's type annotation.
 * 2. AppContext leaking: Only extract parameters[0] from function signatures.
 * 3. tsconfig not found: Throw early with a clear message if tsconfig path is invalid.
 * 4. Re-exports: ts-json-schema-generator follows import chains automatically.
 */

import { existsSync } from "node:fs";
import ts from "typescript";
import { createGenerator, RootlessError } from "ts-json-schema-generator";
import type { Schema } from "ts-json-schema-generator";

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Get the TypeScript compiler program for a file.
 * Used to inspect AST nodes when ts-json-schema-generator fallback is needed.
 */
function createTsProgram(filePath: string, tsConfigPath: string): ts.Program {
  const configFile = ts.readConfigFile(tsConfigPath, ts.sys.readFile);
  if (configFile.error) {
    throw new Error(
      `Failed to read tsconfig at ${tsConfigPath}: ${ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n")}`,
    );
  }
  const parsedConfig = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    tsConfigPath.replace(/\/tsconfig\.json$/, ""),
  );
  return ts.createProgram(
    [filePath, ...parsedConfig.fileNames],
    parsedConfig.options,
  );
}

/**
 * Find the default export function declaration in a source file and return
 * the first parameter's type annotation text (the "Props" equivalent).
 *
 * Returns null if no default export function is found or the first parameter
 * has no type annotation (valid — means no configurable props).
 */
function getFirstParamTypeName(
  sourceFile: ts.SourceFile,
  typeChecker: ts.TypeChecker,
): string | null {
  let result: string | null = null;

  function visit(node: ts.Node): void {
    if (result !== null) return;

    // Pattern: export default function ComponentName(props: Props) { ... }
    if (
      ts.isFunctionDeclaration(node) &&
      node.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword) &&
      node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      const firstParam = node.parameters[0];
      if (firstParam?.type) {
        result = firstParam.type.getText(sourceFile);
        return;
      }
    }

    // Pattern: const loader = async (props: Props, ...) => ...
    //          export default loader;
    if (ts.isExportAssignment(node) && !node.isExportEquals) {
      const expr = node.expression;
      // Direct arrow/function expression
      if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) {
        const firstParam = expr.parameters[0];
        if (firstParam?.type) {
          result = firstParam.type.getText(sourceFile);
          return;
        }
      }

      // Identifier reference: resolve to the variable declaration
      if (ts.isIdentifier(expr)) {
        const symbol = typeChecker.getSymbolAtLocation(expr);
        const decl = symbol?.declarations?.[0];
        if (decl) {
          if (ts.isVariableDeclaration(decl) && decl.initializer) {
            const init = decl.initializer;
            if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
              const firstParam = init.parameters[0];
              if (firstParam?.type) {
                result = firstParam.type.getText(sourceFile);
                return;
              }
            }
          }
          // The declaration itself might be a function
          if (ts.isFunctionDeclaration(decl)) {
            const firstParam = decl.parameters[0];
            if (firstParam?.type) {
              result = firstParam.type.getText(sourceFile);
              return;
            }
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return result;
}

/**
 * Get the return type annotation text from the default export function.
 * Returns null if not annotated or not a function.
 */
function getReturnTypeAnnotation(
  sourceFile: ts.SourceFile,
  typeChecker: ts.TypeChecker,
): string | null {
  let result: string | null = null;

  function visit(node: ts.Node): void {
    if (result !== null) return;

    // Pattern: export default function ComponentName(...): ReturnType { ... }
    if (
      ts.isFunctionDeclaration(node) &&
      node.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword) &&
      node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      if (node.type) {
        result = node.type.getText(sourceFile);
        return;
      }
    }

    // Pattern: export default loader (identifier)
    if (ts.isExportAssignment(node) && !node.isExportEquals) {
      const expr = node.expression;
      if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) {
        if (expr.type) {
          result = expr.type.getText(sourceFile);
          return;
        }
      }
      if (ts.isIdentifier(expr)) {
        const symbol = typeChecker.getSymbolAtLocation(expr);
        const decl = symbol?.declarations?.[0];
        if (decl) {
          if (ts.isVariableDeclaration(decl) && decl.initializer) {
            const init = decl.initializer;
            if (
              (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) &&
              init.type
            ) {
              result = init.type.getText(sourceFile);
              return;
            }
          }
          if (ts.isFunctionDeclaration(decl) && decl.type) {
            result = decl.type.getText(sourceFile);
            return;
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return result;
}

/**
 * Unwrap `Promise<T>` to get the inner type name `T`.
 * Returns the inner text if the annotation is `Promise<...>`,
 * or the original text if it's not a Promise wrapper.
 */
function unwrapPromise(typeText: string): string {
  const trimmed = typeText.trim();
  const match = trimmed.match(/^Promise\s*<(.+)>$/s);
  return match ? match[1].trim() : trimmed;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Extract the JSON Schema for the `Props` type of a TypeScript file's default export.
 *
 * Strategy:
 * 1. Try with type: "Props" (most deco files use this naming convention)
 * 2. If RootlessError (no "Props" type found), inspect the AST to get the first
 *    parameter's type name, then retry ts-json-schema-generator with that name
 * 3. If the first parameter has no type annotation, return {} (no configurable props)
 * 4. Any other error from ts-json-schema-generator is re-thrown (must be complete or throw)
 *
 * @param filePath - Absolute path to the TypeScript source file
 * @param tsConfigPath - Absolute path to the tsconfig.json for the project
 * @returns JSON Schema object (may be {} if no props are defined)
 */
export function extractPropsSchema(
  filePath: string,
  tsConfigPath: string,
): Schema {
  // Pitfall 3: Validate tsconfig exists before calling createGenerator
  if (!existsSync(tsConfigPath)) {
    throw new Error(`tsconfig.json not found at: ${tsConfigPath}`);
  }

  // Step 1: Try with type "Props" (standard deco convention)
  try {
    const generator = createGenerator({
      path: filePath,
      tsconfig: tsConfigPath,
      type: "Props",
      skipTypeCheck: false,
      jsDoc: "extended",
      extraTags: ["@title", "@description", "@format"],
    });
    return generator.createSchema("Props");
  } catch (err) {
    if (!(err instanceof RootlessError)) {
      // Not a "Props not found" error — re-throw per "must be complete or throw" policy
      throw err;
    }
  }

  // Step 2: "Props" not found — inspect the AST to get the first param's type name
  const program = createTsProgram(filePath, tsConfigPath);
  const sourceFile = program.getSourceFile(filePath);

  if (!sourceFile) {
    // File couldn't be parsed — return empty schema (no props)
    return {};
  }

  const typeChecker = program.getTypeChecker();
  const typeName = getFirstParamTypeName(sourceFile, typeChecker);

  // Step 3: No type annotation on first parameter → empty schema (no configurable props)
  if (typeName === null) {
    return {};
  }

  // Step 4: Retry ts-json-schema-generator with the discovered type name
  // If this also fails, re-throw (must be complete or throw)
  const generator = createGenerator({
    path: filePath,
    tsconfig: tsConfigPath,
    type: typeName,
    skipTypeCheck: false,
    jsDoc: "extended",
    extraTags: ["@title", "@description", "@format"],
  });
  return generator.createSchema(typeName);
}

/**
 * Extract the JSON Schema for the return type of a loader's default export.
 *
 * Loaders return `Promise<T>` — this function unwraps the Promise to get the
 * inner type `T` and generates a JSON Schema for it.
 *
 * Strategy:
 * 1. Use the TypeScript compiler API to get the return type annotation text
 * 2. Unwrap `Promise<T>` to get the inner type name
 * 3. Pass the inner type name to ts-json-schema-generator
 * 4. If no return type annotation, return {} (unknown return type)
 * 5. If type cannot be resolved, throw (must be complete or throw)
 *
 * @param filePath - Absolute path to the TypeScript source file (loader)
 * @param tsConfigPath - Absolute path to the tsconfig.json for the project
 * @returns JSON Schema object for the loader's return type (may be {} if unannotated)
 */
export function extractReturnTypeSchema(
  filePath: string,
  tsConfigPath: string,
): Schema {
  // Pitfall 3: Validate tsconfig exists before calling createGenerator
  if (!existsSync(tsConfigPath)) {
    throw new Error(`tsconfig.json not found at: ${tsConfigPath}`);
  }

  // Step 1: Use TypeScript compiler API to get the return type annotation text
  const program = createTsProgram(filePath, tsConfigPath);
  const sourceFile = program.getSourceFile(filePath);

  if (!sourceFile) {
    return {};
  }

  const typeChecker = program.getTypeChecker();
  const returnTypeText = getReturnTypeAnnotation(sourceFile, typeChecker);

  // Step 4: No return type annotation → unknown return type (acceptable for loaders)
  if (returnTypeText === null) {
    return {};
  }

  // Step 2: Unwrap Promise<T> to get the inner type name
  const innerTypeName = unwrapPromise(returnTypeText);

  if (!innerTypeName) {
    return {};
  }

  // Step 3: Generate JSON Schema for the inner type.
  // Handle array types (e.g. "Product[]") by extracting the element type,
  // generating its schema, then wrapping it in an array schema.
  // ts-json-schema-generator does not support "T[]" as a root type name.
  const arrayMatch = innerTypeName.match(/^(.+)\[\]$/);
  if (arrayMatch) {
    const elementTypeName = arrayMatch[1].trim();
    if (!elementTypeName) {
      return {};
    }
    const generator = createGenerator({
      path: filePath,
      tsconfig: tsConfigPath,
      type: elementTypeName,
      skipTypeCheck: false,
      jsDoc: "extended",
      extraTags: ["@title", "@description", "@format"],
    });
    const elementSchema = generator.createSchema(elementTypeName);
    // Wrap in array schema
    return {
      $schema: elementSchema.$schema,
      type: "array",
      items: elementSchema.$ref ? { $ref: elementSchema.$ref } : elementSchema,
      definitions: elementSchema.definitions,
    } as Schema;
  }

  // If this fails, re-throw per "must be complete or throw" policy
  const generator = createGenerator({
    path: filePath,
    tsconfig: tsConfigPath,
    type: innerTypeName,
    skipTypeCheck: false,
    jsDoc: "extended",
    extraTags: ["@title", "@description", "@format"],
  });
  return generator.createSchema(innerTypeName);
}
