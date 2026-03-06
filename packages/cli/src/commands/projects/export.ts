/**
 * Export a project to a local directory
 */
import fs from "node:fs/promises";
import path from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import inquirer from "inquirer";
import { promptWorkspace } from "../../lib/prompt-workspace.js";
import { promptProject } from "../../lib/prompt-project.js";
import { createWorkspaceClient } from "../../lib/mcp.js";
import { fetchFileContent } from "../deconfig/base.js";
import {
  writeManifestFile,
  extractDependenciesFromTools,
} from "../../lib/mcp-manifest.js";
import { sanitizeProjectPath } from "../../lib/projects.js";
import {
  viewJsonToCode,
  toolJsonToCode,
  workflowJsonToCode,
  type ViewResource,
  type ToolResource,
  type WorkflowResource,
} from "../../lib/code-conversion.js";

interface ExportOptions {
  org?: string;
  project?: string;
  out?: string;
  local?: boolean;
  force?: boolean;
}

const ALLOWED_ROOTS = [
  "/src/tools",
  "/src/views",
  "/src/workflows",
  "/src/documents",
];
const AGENTS_DIR = "agents";
const DATABASE_DIR = "database";

function sanitizeTableFilename(tableName: string): string {
  return tableName.replace(/[^a-zA-Z0-9-_]/g, "-");
}

type SqlStatement = {
  results?: unknown[];
  [key: string]: unknown;
};

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (items.length === 0 || limit <= 0) {
    return;
  }

  let nextIndex = 0;
  const size = Math.min(limit, items.length);

  const runners = Array.from({ length: size }, async () => {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) {
        break;
      }
      // eslint-disable-next-line no-await-in-loop
      await worker(items[currentIndex], currentIndex);
    }
  });

  await Promise.all(runners);
}

export async function exportCommand(options: ExportOptions): Promise<void> {
  const { local, force } = options;

  console.log("📦 Starting project export...\n");

  // Step 1: Resolve org and project
  let orgSlug = options.org;
  if (!orgSlug) {
    orgSlug = await promptWorkspace(local);
  }
  console.log(`📍 Organization: ${orgSlug}`);

  let project = options.project;
  let projectData;
  if (!project) {
    projectData = await promptProject(orgSlug, local);
    project = projectData.slug;
  } else {
    // Fetch project data using global PROJECTS_LIST tool
    const client = await createWorkspaceClient({ workspace: "", local });
    try {
      const response = await client.callTool({
        name: "PROJECTS_LIST",
        arguments: { org: orgSlug },
      });
      if (response.isError) {
        throw new Error(`Failed to fetch projects: ${response.content}`);
      }
      const { items: projects } = response.structuredContent as {
        items: Array<{
          id: string;
          slug: string;
          title: string;
          description?: string;
        }>;
      };
      projectData = projects.find((p) => p.slug === project);
      if (!projectData) {
        throw new Error(
          `Project '${project}' not found in organization '${orgSlug}'`,
        );
      }
    } finally {
      await client.close();
    }
  }
  console.log(`📍 Project: ${projectData.title} (${projectData.slug})\n`);

  // Step 2: Determine output directory
  let outDir: string = options.out || "";
  if (!outDir) {
    const defaultOut = `./${orgSlug}__${projectData.slug}`;
    const result = await inquirer.prompt([
      {
        type: "input",
        name: "outDir",
        message: "Output directory:",
        default: defaultOut,
      },
    ]);
    outDir = result.outDir as string;
  }

  // Check if directory exists and is not empty
  if (existsSync(outDir)) {
    const files = await fs.readdir(outDir);
    if (files.length > 0) {
      if (!force) {
        throw new Error(
          `Output directory '${outDir}' is not empty. Use --force to overwrite existing files.`,
        );
      }
      console.log(
        `⚠️  Output directory is not empty. Using --force to overwrite.\n`,
      );
    }
  } else {
    mkdirSync(outDir, { recursive: true });
    console.log(`📁 Created output directory: ${outDir}\n`);
  }

  const resolvedOutDir = path.resolve(outDir);

  // Step 3: Connect to project workspace
  const workspace = `/${orgSlug}/${projectData.slug}`;
  const client = await createWorkspaceClient({ workspace, local });

  try {
    // Step 4: Fetch all files from allowed roots
    console.log("📋 Fetching project files...");
    const allFiles: Array<{ path: string; content: string }> = [];
    const resourcesByType: Record<string, string[]> = {
      tools: [],
      views: [],
      workflows: [],
      documents: [],
      database: [],
    };

    for (const root of ALLOWED_ROOTS) {
      const response = await client.callTool({
        name: "LIST_FILES",
        arguments: {
          branch: "main",
          prefix: root,
        },
      });

      if (response.isError) {
        console.warn(`⚠️  Failed to list files in ${root}: ${response.content}`);
        continue;
      }

      const result = response.structuredContent as {
        files: Record<
          string,
          {
            address: string;
            metadata: Record<string, unknown>;
            mtime: number;
            ctime: number;
          }
        >;
        count: number;
      };

      if (result.count === 0) {
        console.log(`   ${root}: 0 files`);
        continue;
      }

      console.log(`   ${root}: ${result.count} files`);

      const filePaths = Object.keys(result.files);

      await runWithConcurrency(filePaths, 5, async (filePath) => {
        try {
          const content = await fetchFileContent(
            filePath,
            "main",
            workspace,
            local,
          );
          const contentStr = content.toString("utf-8");
          allFiles.push({ path: filePath, content: contentStr });

          if (filePath.startsWith("/src/tools/")) {
            resourcesByType.tools.push(filePath);
          } else if (filePath.startsWith("/src/views/")) {
            resourcesByType.views.push(filePath);
          } else if (filePath.startsWith("/src/workflows/")) {
            resourcesByType.workflows.push(filePath);
          } else if (filePath.startsWith("/src/documents/")) {
            resourcesByType.documents.push(filePath);
          }

          let relativePath = filePath.startsWith("/")
            ? filePath.slice(1)
            : filePath;
          if (relativePath.startsWith("src/")) {
            relativePath = relativePath.slice(4);
          }

          const sanitizedRelativePath = sanitizeProjectPath(relativePath);
          if (!sanitizedRelativePath) {
            console.warn(`   ⚠️  Skipping unsafe path: ${filePath}`);
            return;
          }

          const localPath = path.join(outDir, sanitizedRelativePath);
          const resolvedLocalPath = path.resolve(localPath);
          const relativeToOut = path.relative(
            resolvedOutDir,
            resolvedLocalPath,
          );
          if (
            relativeToOut.startsWith("..") ||
            path.isAbsolute(relativeToOut)
          ) {
            console.warn(
              `   ⚠️  Skipping path outside output directory: ${sanitizedRelativePath}`,
            );
            return;
          }

          await fs.mkdir(path.dirname(resolvedLocalPath), { recursive: true });

          // Convert JSON resources to code files
          let finalContent = contentStr;
          let finalPath = resolvedLocalPath;

          if (filePath.endsWith(".json")) {
            try {
              const parsed = JSON.parse(contentStr);

              if (filePath.startsWith("/src/views/")) {
                const viewResource = parsed as ViewResource;
                finalContent = viewJsonToCode(viewResource);
                finalPath = resolvedLocalPath.replace(/\.json$/, ".tsx");
              } else if (filePath.startsWith("/src/tools/")) {
                const toolResource = parsed as ToolResource;
                finalContent = toolJsonToCode(toolResource);
                finalPath = resolvedLocalPath.replace(/\.json$/, ".ts");
              } else if (filePath.startsWith("/src/workflows/")) {
                const workflowResource = parsed as WorkflowResource;
                finalContent = workflowJsonToCode(workflowResource);
                finalPath = resolvedLocalPath.replace(/\.json$/, ".ts");
              }
            } catch (conversionError) {
              console.warn(
                `   ⚠️  Failed to convert ${filePath} to code file: ${conversionError instanceof Error ? conversionError.message : String(conversionError)}`,
              );
              // Fall back to writing the original JSON
            }
          }

          await fs.writeFile(finalPath, finalContent, "utf-8");
        } catch (error) {
          console.warn(
            `   ⚠️  Failed to download ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      });
    }

    console.log(`✅ Downloaded ${allFiles.length} files\n`);

    // Step 5: Export agents
    console.log("👤 Fetching agents...");
    const agentsDir = path.join(outDir, AGENTS_DIR);
    mkdirSync(agentsDir, { recursive: true });
    let agentCount = 0;

    try {
      // First, get the list of agent IDs
      const agentsListResponse = await client.callTool({
        name: "AGENTS_LIST",
        arguments: {},
      });

      if (agentsListResponse.isError) {
        console.warn(
          `⚠️  Failed to fetch agents: ${agentsListResponse.content}`,
        );
      } else {
        const agentsListData = agentsListResponse.structuredContent as {
          items: Array<{ id: string; name: string }>;
        };

        console.log(`   Found ${agentsListData.items.length} agents`);

        await runWithConcurrency(
          agentsListData.items,
          5,
          async (agentSummary) => {
            try {
              const agentResponse = await client.callTool({
                name: "AGENTS_GET",
                arguments: { id: agentSummary.id },
              });

              if (agentResponse.isError) {
                console.warn(
                  `   ⚠️  Failed to fetch agent ${agentSummary.name}: ${agentResponse.content}`,
                );
                return;
              }

              const agent = agentResponse.structuredContent as {
                id: string;
                name: string;
                avatar: string;
                instructions: string;
                description?: string;
                tools_set: Record<string, string[]>;
                max_steps?: number;
                max_tokens?: number;
                model: string;
                memory?: unknown;
                views: unknown;
                visibility: string;
                temperature?: number;
              };

              const exportAgent = {
                name: agent.name,
                avatar: agent.avatar,
                instructions: agent.instructions,
                description: agent.description,
                tools_set: agent.tools_set,
                max_steps: agent.max_steps,
                max_tokens: agent.max_tokens,
                model: agent.model,
                memory: agent.memory,
                views: agent.views,
                visibility: agent.visibility,
                temperature: agent.temperature,
              };

              const safeFilename = agent.name
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "-")
                .replace(/^-+|-+$/g, "");
              const agentFile = path.join(agentsDir, `${safeFilename}.json`);

              await fs.writeFile(
                agentFile,
                JSON.stringify(exportAgent, null, 2) + "\n",
                "utf-8",
              );

              const current = ++agentCount;
              if (
                current % 5 === 0 ||
                current === agentsListData.items.length
              ) {
                console.log(
                  `   Exported ${current}/${agentsListData.items.length} agents...`,
                );
              }
            } catch (error) {
              console.warn(
                `   ⚠️  Failed to export agent ${agentSummary.name}: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
          },
        );

        console.log(`   ✅ Exported ${agentCount} agents\n`);
      }
    } catch (error) {
      console.warn(`⚠️  Failed to export agents: ${error}`);
    }

    // Step 6: Export database schema
    console.log("🗄️ Exporting database schema...");
    const databaseDir = path.join(outDir, DATABASE_DIR);
    mkdirSync(databaseDir, { recursive: true });
    let tableCount = 0;

    try {
      // Query table names from information_schema
      const tablesResponse = await client.callTool({
        name: "DATABASES_RUN_SQL",
        arguments: {
          sql: `SELECT table_name FROM information_schema.tables
                WHERE table_schema = current_schema()
                  AND table_type = 'BASE TABLE'
                ORDER BY table_name`,
        },
      });

      if (tablesResponse.isError) {
        console.warn(
          `⚠️  Failed to fetch database schema: ${tablesResponse.content}`,
        );
      }

      const tablesStatements = ((
        tablesResponse.structuredContent as { result?: SqlStatement[] }
      )?.result ?? []) as SqlStatement[];
      const tableRows = tablesStatements.flatMap((statement) =>
        Array.isArray(statement.results) ? statement.results : [],
      ) as Array<Record<string, unknown>>;

      const tableNames = tableRows
        .map((row) => String(row.table_name ?? ""))
        .filter(
          (name) =>
            name && !name.startsWith("pg_") && !name.startsWith("mastra_"),
        );

      if (tableNames.length > 0) {
        // Query column details for all tables
        const quotedNames = tableNames
          .map((n) => `'${n.replace(/'/g, "''")}'`)
          .join(", ");
        const columnsResponse = await client.callTool({
          name: "DATABASES_RUN_SQL",
          arguments: {
            sql: `SELECT table_name, column_name, data_type, udt_name,
                         character_maximum_length, numeric_precision, numeric_scale,
                         is_nullable, column_default
                  FROM information_schema.columns
                  WHERE table_schema = current_schema()
                    AND table_name IN (${quotedNames})
                  ORDER BY table_name, ordinal_position`,
          },
        });

        if (columnsResponse.isError) {
          console.warn(
            `⚠️  Failed to fetch column details: ${columnsResponse.content}`,
          );
        }

        const columnsStatements = ((
          columnsResponse.structuredContent as { result?: SqlStatement[] }
        )?.result ?? []) as SqlStatement[];
        const columnRows = columnsStatements.flatMap((statement) =>
          Array.isArray(statement.results) ? statement.results : [],
        ) as Array<Record<string, unknown>>;

        // Query table constraints (PRIMARY KEY, UNIQUE, FOREIGN KEY, CHECK)
        const constraintsResponse = await client.callTool({
          name: "DATABASES_RUN_SQL",
          arguments: {
            sql: `SELECT
                    tc.table_name,
                    tc.constraint_name,
                    tc.constraint_type,
                    pg_get_constraintdef(pgc.oid) AS constraint_def
                  FROM information_schema.table_constraints tc
                  JOIN pg_class pgrel
                    ON pgrel.relname = tc.table_name
                   AND pgrel.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = current_schema())
                  JOIN pg_constraint pgc
                    ON pgc.conname = tc.constraint_name
                   AND pgc.conrelid = pgrel.oid
                  WHERE tc.table_schema = current_schema()
                    AND tc.table_name IN (${quotedNames})
                  ORDER BY tc.table_name, tc.constraint_type, tc.constraint_name`,
          },
        });

        if (constraintsResponse.isError) {
          console.warn(
            `⚠️  Failed to fetch table constraints: ${constraintsResponse.content}`,
          );
        }

        const constraintsStatements = ((
          constraintsResponse.structuredContent as { result?: SqlStatement[] }
        )?.result ?? []) as SqlStatement[];
        const constraintRows = constraintsStatements.flatMap((statement) =>
          Array.isArray(statement.results) ? statement.results : [],
        ) as Array<Record<string, unknown>>;

        // Query indexes from pg_indexes
        const indexesResponse = await client.callTool({
          name: "DATABASES_RUN_SQL",
          arguments: {
            sql: `SELECT tablename, indexname, indexdef
                  FROM pg_indexes
                  WHERE schemaname = current_schema()
                    AND tablename IN (${quotedNames})
                  ORDER BY tablename, indexname`,
          },
        });

        if (indexesResponse.isError) {
          console.warn(
            `⚠️  Failed to fetch indexes: ${indexesResponse.content}`,
          );
        }

        const indexesStatements = ((
          indexesResponse.structuredContent as { result?: SqlStatement[] }
        )?.result ?? []) as SqlStatement[];
        const indexRows = indexesStatements.flatMap((statement) =>
          Array.isArray(statement.results) ? statement.results : [],
        ) as Array<Record<string, unknown>>;

        // Group columns by table
        const columnsByTable = new Map<
          string,
          Array<{
            column_name: string;
            data_type: string;
            udt_name: string;
            character_maximum_length: number | null;
            numeric_precision: number | null;
            numeric_scale: number | null;
            is_nullable: string;
            column_default: string | null;
          }>
        >();
        for (const row of columnRows) {
          const tableName = String(row.table_name ?? "");
          const cols = columnsByTable.get(tableName) ?? [];
          cols.push({
            column_name: String(row.column_name ?? ""),
            data_type: String(row.data_type ?? ""),
            udt_name: String(row.udt_name ?? ""),
            character_maximum_length:
              row.character_maximum_length != null
                ? Number(row.character_maximum_length)
                : null,
            numeric_precision:
              row.numeric_precision != null
                ? Number(row.numeric_precision)
                : null,
            numeric_scale:
              row.numeric_scale != null ? Number(row.numeric_scale) : null,
            is_nullable: String(row.is_nullable ?? "YES"),
            column_default:
              row.column_default != null ? String(row.column_default) : null,
          });
          columnsByTable.set(tableName, cols);
        }

        // Group constraints by table (excluding PK constraints that will be inlined)
        const constraintsByTable = new Map<
          string,
          Array<{
            constraint_name: string;
            constraint_type: string;
            constraint_def: string;
          }>
        >();
        // Track which constraints back indexes so we can exclude them
        const constraintIndexNames = new Set<string>();
        for (const row of constraintRows) {
          const tableName = String(row.table_name ?? "");
          const constraintName = String(row.constraint_name ?? "");
          const constraintType = String(row.constraint_type ?? "");
          const constraintDef = String(row.constraint_def ?? "");
          const constraints = constraintsByTable.get(tableName) ?? [];
          constraints.push({
            constraint_name: constraintName,
            constraint_type: constraintType,
            constraint_def: constraintDef,
          });
          constraintsByTable.set(tableName, constraints);
          // PostgreSQL auto-creates indexes for PK and UNIQUE constraints
          if (constraintType === "PRIMARY KEY" || constraintType === "UNIQUE") {
            constraintIndexNames.add(constraintName);
          }
        }

        // Group indexes by table (excluding constraint-backed indexes)
        const indexesByTable = new Map<
          string,
          Array<{ name: string; sql: string }>
        >();
        for (const row of indexRows) {
          const tableName = String(row.tablename ?? "");
          const indexName = String(row.indexname ?? "");
          const indexDef = String(row.indexdef ?? "");
          // Skip auto-generated indexes for PK/UNIQUE constraints
          if (constraintIndexNames.has(indexName)) {
            continue;
          }
          const collection = indexesByTable.get(tableName) ?? [];
          collection.push({ name: indexName, sql: indexDef });
          indexesByTable.set(tableName, collection);
        }

        // Build CREATE TABLE DDL for each table
        for (const tableName of tableNames) {
          const columns = columnsByTable.get(tableName) ?? [];
          if (columns.length === 0) {
            continue;
          }

          const columnDefs = columns.map((col) => {
            let typeName: string;
            // Use udt_name for user-defined types (e.g., int4, varchar, text)
            // which gives the actual PostgreSQL type name
            const udt = col.udt_name;
            if (col.data_type === "USER-DEFINED") {
              typeName = udt;
            } else if (col.data_type === "ARRAY") {
              typeName = `${udt.replace(/^_/, "")}[]`;
            } else if (
              col.data_type === "character varying" &&
              col.character_maximum_length != null
            ) {
              typeName = `varchar(${col.character_maximum_length})`;
            } else if (
              col.data_type === "character" &&
              col.character_maximum_length != null
            ) {
              typeName = `char(${col.character_maximum_length})`;
            } else if (
              col.data_type === "numeric" &&
              col.numeric_precision != null
            ) {
              typeName =
                col.numeric_scale != null
                  ? `numeric(${col.numeric_precision}, ${col.numeric_scale})`
                  : `numeric(${col.numeric_precision})`;
            } else {
              typeName = col.data_type;
            }

            let def = `  "${col.column_name}" ${typeName}`;
            if (col.is_nullable === "NO") {
              def += " NOT NULL";
            }
            if (col.column_default != null) {
              def += ` DEFAULT ${col.column_default}`;
            }
            return def;
          });

          // Add table-level constraints
          const constraints = constraintsByTable.get(tableName) ?? [];
          const constraintDefs = constraints.map(
            (c) => `  CONSTRAINT "${c.constraint_name}" ${c.constraint_def}`,
          );

          const allDefs = [...columnDefs, ...constraintDefs];
          const createSql = `CREATE TABLE "${tableName}" (\n${allDefs.join(",\n")}\n)`;

          const safeFilename = `${sanitizeTableFilename(tableName)}.json`;
          const tablePath = path.join(databaseDir, safeFilename);
          const payload = {
            name: tableName,
            createSql,
            indexes: indexesByTable.get(tableName) ?? [],
          };
          await fs.writeFile(
            tablePath,
            JSON.stringify(payload, null, 2) + "\n",
            "utf-8",
          );
          resourcesByType.database.push(`/${DATABASE_DIR}/${safeFilename}`);
          tableCount++;
        }
      }

      console.log(`   ✅ Exported ${tableCount} tables\n`);
    } catch (error) {
      console.warn(
        `⚠️  Failed to export database schema: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    // Step 7: Extract dependencies
    console.log("🔍 Extracting dependencies...");
    const toolFiles = allFiles.filter((f) => f.path.startsWith("/src/tools/"));
    const dependencies = await extractDependenciesFromTools(toolFiles);
    console.log(
      `   Found ${dependencies.length} MCP dependencies: ${dependencies.join(", ") || "none"}\n`,
    );

    // Step 8: Fetch author info
    console.log("👤 Fetching author info...");
    let userEmail: string | undefined;
    let userId: string | undefined;

    try {
      const profileResponse = await client.callTool({
        name: "PROFILES_GET",
        arguments: {},
      });
      if (!profileResponse.isError) {
        const profile = profileResponse.structuredContent as {
          email?: string;
          id?: string;
        };
        userEmail = profile.email;
        userId = profile.id;
      }
    } catch {
      // Ignore
    }
    console.log(`   User: ${userEmail || "unknown"}\n`);

    // Step 9: Build and write manifest
    console.log("📝 Writing manifest...");

    // Helper to strip /src/ prefix from paths
    const stripSrcPrefix = (paths: string[]): string[] =>
      paths.map((p) => p.replace(/^\/src\//, "/"));

    const manifest = {
      schemaVersion: "1.0" as const,
      project: {
        slug: projectData.slug,
        title: projectData.title,
        description: projectData.description,
      },
      author: {
        orgSlug,
        userId,
        userEmail,
      },
      resources: {
        tools: stripSrcPrefix(resourcesByType.tools),
        views: stripSrcPrefix(resourcesByType.views),
        workflows: stripSrcPrefix(resourcesByType.workflows),
        documents: stripSrcPrefix(resourcesByType.documents),
        database: resourcesByType.database,
      },
      dependencies: {
        mcps: dependencies,
      },
      createdAt: new Date().toISOString(),
    };

    await writeManifestFile(outDir, manifest);
    console.log(
      `   ✅ Manifest written to ${path.join(outDir, "deco.mcp.json")}\n`,
    );

    // Step 10: Print summary
    console.log("🎉 Export completed successfully!\n");
    console.log("📊 Summary:");
    console.log(`   Tools: ${resourcesByType.tools.length}`);
    console.log(`   Views: ${resourcesByType.views.length}`);
    console.log(`   Workflows: ${resourcesByType.workflows.length}`);
    console.log(`   Documents: ${resourcesByType.documents.length}`);
    console.log(`   Database tables: ${resourcesByType.database.length}`);
    console.log(`   Agents: ${agentCount}`);
    console.log(`   Dependencies: ${dependencies.length}`);
    console.log(`   Output: ${outDir}`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("\n💥 Export failed:", errorMessage);
    process.exit(1);
  } finally {
    await client.close();
  }
}
