/**
 * Direct Postgres access for scenarios that need to inspect server-side
 * state not exposed through the public API.
 *
 * Use sparingly: anything observable via MCP/HTTP should be observed
 * that way. This helper exists for the cases where the only thing we
 * need (e.g. `threads.run_owner_pod` for targeted-kill scenarios) is
 * deliberately internal. Shells out via `docker compose exec` so we
 * don't have to expose a host port.
 */

const COMPOSE_FILE = new URL("../docker-compose.yml", import.meta.url).pathname;

/**
 * Run a SQL query against the cluster's postgres and return rows as an
 * array of objects keyed by column name. Output is RFC-4180 CSV (psql's
 * `--csv` mode quotes fields containing commas/quotes/newlines), but our
 * parser is intentionally naive: it splits on raw commas. So don't
 * `SELECT` columns whose values can contain a literal "," character
 * unless you tighten the parser too.
 */
export async function dbQuery<T extends Record<string, string | null>>(
  sql: string,
): Promise<T[]> {
  const proc = Bun.spawn(
    [
      "docker",
      "compose",
      "-f",
      COMPOSE_FILE,
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "--csv",
      "-c",
      sql,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`dbQuery failed (exit ${code}): ${stderr || stdout}`);
  }

  const lines = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return [];

  const headers = lines[0]!.split(",");
  return lines.slice(1).map((line) => {
    // psql --csv quotes fields containing commas/quotes; we don't need
    // robust parsing here because our queries select stable scalars
    // (ids, pod ids). Strip surrounding quotes if present.
    const cells = line.split(",").map((c) => c.replace(/^"|"$/g, ""));
    const row: Record<string, string | null> = {};
    headers.forEach((h, i) => {
      const v = cells[i];
      row[h] = v === "" || v == null ? null : v;
    });
    return row as T;
  });
}

/**
 * Convenience: look up which pod a thread's run is currently assigned to.
 * Returns null when the thread doesn't exist or the run hasn't been
 * claimed yet (run_owner_pod is null until RUN_STARTED fires).
 */
export async function getThreadRunOwnerPod(
  threadId: string,
): Promise<string | null> {
  const rows = await dbQuery<{ run_owner_pod: string | null }>(
    `SELECT run_owner_pod FROM threads WHERE id = '${threadId.replace(/'/g, "''")}'`,
  );
  return rows[0]?.run_owner_pod ?? null;
}

/** Single-quote escape for inlining ids into SQL (ids are uuid-ish, but
 *  belt-and-suspenders — shared by scenarios that need it beyond the
 *  string-literal ids `dbQuery`'s callers already build inline). */
function sqlLit(v: string): string {
  return v.replace(/'/g, "''");
}

/** The persisted `threads.status` for a thread, or null if absent. */
export async function getThreadStatus(
  threadId: string,
): Promise<string | null> {
  const rows = await dbQuery<{ status: string | null }>(
    `SELECT status FROM threads WHERE id = '${sqlLit(threadId)}'`,
  );
  return rows[0]?.status ?? null;
}

/** Count of persisted `thread_message_parts` rows for a thread. `COUNT(*)`
 *  is a stable scalar, safe for this module's naive (comma-splitting) CSV
 *  parser. */
export async function countThreadMessageParts(
  threadId: string,
): Promise<number> {
  const rows = await dbQuery<{ n: string }>(
    `SELECT COUNT(*) AS n FROM thread_message_parts WHERE thread_id = '${sqlLit(threadId)}'`,
  );
  return Number(rows[0]?.n ?? "0");
}

/**
 * Count assistant parts that would actually RENDER in the chat — i.e. every
 * kind except the `finish` anchor (text/reasoning/tool_call/tool_result/
 * file/error). Zero of these on a terminal thread is exactly the
 * "No response was generated" condition: a message with a finish anchor
 * (or nothing) but no visible content. This is the invariant the
 * rollout-churn scenario asserts.
 */
export async function countRenderableAssistantParts(
  threadId: string,
): Promise<number> {
  const rows = await dbQuery<{ n: string }>(
    `SELECT COUNT(*) AS n FROM thread_message_parts
     WHERE thread_id = '${sqlLit(threadId)}'
       AND role = 'assistant'
       AND kind <> 'finish'`,
  );
  return Number(rows[0]?.n ?? "0");
}
