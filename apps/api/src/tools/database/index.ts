import { sql } from "kysely";
import type { Kysely } from "kysely";
import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth } from "../../core/studio-context";
import type { Database } from "../../storage/types";

const QueryResult = z.object({
  results: z.array(z.unknown()).optional(),
  success: z.boolean().optional(),
});

/**
 * Safely escape and quote SQL values
 * This is still not as safe as parameterized queries, but better than raw replacement
 */
function escapeSqlValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "NULL";
  }

  if (typeof value === "number") {
    return String(value);
  }

  if (typeof value === "boolean") {
    return value ? "TRUE" : "FALSE";
  }

  if (typeof value === "string") {
    // Escape single quotes by doubling them (SQL standard)
    // and wrap in quotes
    return `'${value.replace(/'/g, "''")}'`;
  }

  if (value instanceof Date) {
    return `'${value.toISOString()}'`;
  }

  // For arrays, objects, etc - serialize to JSON string
  return `'${JSON.stringify(value).replace(/'/g, "''")}'`;
}

/**
 * Replace ALL placeholders (?, $1, $2, etc.) with escaped values.
 *
 * Walks the ORIGINAL sql string once, left to right, and only ever appends
 * escaped values to the output — it never re-scans text it already produced.
 * A prior version substituted placeholders in separate passes over a `result`
 * string that grew with each pass; an escaped param containing a literal `?`
 * or `$1` (e.g. a string param holding "a?b") was then picked up as a REAL
 * placeholder by a later pass and substituted again, corrupting the query.
 *
 * Also tracks single- and double-quoted state: a literal `?` or `$1` typed
 * inside the SQL text's own string literal (`'what?'`) or a quoted identifier
 * (`"col?"`) is not a placeholder — treating it as one both mangles that
 * literal/identifier and steals a positional slot from the real placeholder
 * later in the query. A doubled `''`/`""` keeps the string/identifier open,
 * matching how Postgres itself reads an escaped quote.
 */
export function interpolateParams(sql: string, params: unknown[]): string {
  let result = "";
  let questionMarkIndex = 0;
  let inString = false;
  let inIdentifier = false;
  // A DO/CREATE FUNCTION body's own $1 (its arg, not our param) lives here.
  let dollarQuoteTag: string | null = null;
  for (let i = 0; i < sql.length; i++) {
    const char = sql[i];
    if (dollarQuoteTag !== null) {
      const closeDelim = `$${dollarQuoteTag}$`;
      if (sql.startsWith(closeDelim, i)) {
        result += closeDelim;
        i += closeDelim.length - 1;
        dollarQuoteTag = null;
      } else {
        result += char;
      }
      continue;
    }
    if (!inIdentifier && char === "'") {
      inString = !inString;
      result += char;
      continue;
    }
    if (!inString && char === '"') {
      inIdentifier = !inIdentifier;
      result += char;
      continue;
    }
    if (!inString && !inIdentifier && char === "$") {
      const match = /^\$(\d+)/.exec(sql.slice(i));
      const paramIndex = match ? Number(match[1]) - 1 : -1;
      if (match && paramIndex >= 0 && paramIndex < params.length) {
        result += escapeSqlValue(params[paramIndex]);
        i += match[0].length - 1;
        continue;
      }
      // A tag can't start with a digit, so this never fights the $1 case above.
      const quoteStart = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (quoteStart) {
        dollarQuoteTag = quoteStart[1] ?? "";
        result += quoteStart[0];
        i += quoteStart[0].length - 1;
        continue;
      }
    } else if (
      !inString &&
      !inIdentifier &&
      char === "?" &&
      questionMarkIndex < params.length
    ) {
      result += escapeSqlValue(params[questionMarkIndex]);
      questionMarkIndex++;
      continue;
    }
    result += char;
  }
  return result;
}

export type QueryResult = z.infer<typeof QueryResult>;

const DatatabasesRunSqlInputSchema = z.object({
  sql: z.string().describe("The SQL query to run"),
  params: z
    .array(z.unknown())
    .describe("The parameters to pass to the SQL query")
    .optional(),
});

function sanitizeIdentifier(connectionId: string): string {
  return connectionId.replace(/-/g, "_");
}

function getSchemaName(connectionId: string): string {
  return `app_${sanitizeIdentifier(connectionId)}`;
}

function getRoleName(connectionId: string): string {
  return `app_role_${sanitizeIdentifier(connectionId)}`;
}

function isRoleOrSchemaNotFoundError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    // PostgreSQL error codes:
    // 3F000 - invalid_schema_name (schema doesn't exist)
    // 42704 - undefined_object (role doesn't exist)
    // 22023 - invalid_parameter_value (SET LOCAL ROLE with non-existent role)
    const code = (error as { code?: string }).code;
    return (
      code === "3F000" ||
      code === "42704" ||
      code === "22023" ||
      (msg.includes("schema") && msg.includes("does not exist")) ||
      (msg.includes("role") && msg.includes("does not exist"))
    );
  }
  return false;
}

/**
 * Create schema and role for a connection with proper isolation.
 * - Creates a dedicated schema for the connection
 * - Creates a dedicated role with access ONLY to that schema
 * - Revokes access to public schema for this role
 */
async function createSchemaAndRole(
  db: Kysely<Database>,
  schemaName: string,
  roleName: string,
): Promise<void> {
  // Create the schema
  await sql`CREATE SCHEMA IF NOT EXISTS ${sql.id(schemaName)}`.execute(db);

  // Create the role if it doesn't exist (NOLOGIN = can't be used to connect directly)
  // Note: We query pg_roles separately because DO blocks don't support parameter binding
  const roleExists = await sql<{ exists: boolean }>`
    SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${roleName}) as exists
  `.execute(db);

  if (!roleExists.rows[0]?.exists) {
    await sql`CREATE ROLE ${sql.id(roleName)} NOLOGIN`.execute(db);
  }

  // Grant the role to the current user so SET ROLE works
  // Required for Cloud SQL where the connecting user isn't a true superuser
  await sql`GRANT ${sql.id(roleName)} TO CURRENT_USER`.execute(db);

  // Grant access to the connection's schema only
  await sql`GRANT USAGE, CREATE ON SCHEMA ${sql.id(schemaName)} TO ${sql.id(roleName)}`.execute(
    db,
  );
  await sql`GRANT ALL ON ALL TABLES IN SCHEMA ${sql.id(schemaName)} TO ${sql.id(roleName)}`.execute(
    db,
  );
  await sql`GRANT ALL ON ALL SEQUENCES IN SCHEMA ${sql.id(schemaName)} TO ${sql.id(roleName)}`.execute(
    db,
  );

  // Ensure future tables in this schema are also accessible
  await sql`ALTER DEFAULT PRIVILEGES IN SCHEMA ${sql.id(schemaName)} GRANT ALL ON TABLES TO ${sql.id(roleName)}`.execute(
    db,
  );
  await sql`ALTER DEFAULT PRIVILEGES IN SCHEMA ${sql.id(schemaName)} GRANT ALL ON SEQUENCES TO ${sql.id(roleName)}`.execute(
    db,
  );

  // Revoke access to public schema (isolation)
  await sql`REVOKE ALL ON SCHEMA public FROM ${sql.id(roleName)}`.execute(db);
}

/**
 * Execute a query with proper schema and role isolation.
 * Uses a transaction with SET LOCAL to ensure concurrency safety.
 * SET LOCAL only affects the current transaction - when it ends,
 * settings are automatically reset, preventing cross-request leakage.
 */
async function executeWithIsolation(
  db: Kysely<Database>,
  schemaName: string,
  roleName: string,
  sqlQuery: string,
): Promise<unknown> {
  try {
    // Use a transaction with SET LOCAL for concurrency-safe isolation
    // SET LOCAL only affects the current transaction - no leakage to other requests
    return await db.transaction().execute(async (trx) => {
      await sql`SET LOCAL ROLE ${sql.id(roleName)}`.execute(trx);
      await sql`SET LOCAL search_path TO ${sql.id(schemaName)}`.execute(trx);
      return await sql.raw(sqlQuery).execute(trx);
    });
  } catch (error) {
    if (isRoleOrSchemaNotFoundError(error)) {
      // Schema or role doesn't exist - create them (outside transaction)
      await createSchemaAndRole(db, schemaName, roleName);

      // Retry with new transaction
      return await db.transaction().execute(async (trx) => {
        await sql`SET LOCAL ROLE ${sql.id(roleName)}`.execute(trx);
        await sql`SET LOCAL search_path TO ${sql.id(schemaName)}`.execute(trx);
        return await sql.raw(sqlQuery).execute(trx);
      });
    }
    throw error;
  }
}

export const DATABASES_RUN_SQL = defineTool({
  name: "DATABASES_RUN_SQL",
  description:
    "Run a SQL query in a connection-scoped isolated schema. Supports SELECT, DDL, and DML.",
  annotations: {
    title: "Run SQL Query",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: DatatabasesRunSqlInputSchema,
  outputSchema: z.object({
    result: z.array(QueryResult),
  }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const sqlQuery = interpolateParams(input.sql, input.params || []);

    if (!ctx.connectionId) {
      throw new Error("Connection context required for database access");
    }

    // Usage probe — evaluating whether to deprecate this tool. Filter on
    // `tool.deprecation_probe = "DATABASES_RUN_SQL"` in OTLP logs.
    console.warn("DATABASES_RUN_SQL invoked", {
      "tool.deprecation_probe": "DATABASES_RUN_SQL",
      "connection.id": ctx.connectionId,
      "organization.id": ctx.organization?.id ?? null,
      "user.id": ctx.auth.user?.id ?? null,
    });

    const schemaName = getSchemaName(ctx.connectionId);
    const roleName = getRoleName(ctx.connectionId);

    const result = await executeWithIsolation(
      ctx.db,
      schemaName,
      roleName,
      sqlQuery,
    );

    return {
      result: [
        { results: (result as { rows: unknown[] }).rows, success: true },
      ],
    };
  },
});
