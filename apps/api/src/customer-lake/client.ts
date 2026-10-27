/**
 * The customer data lake: ClickHouse database `customer_lake` (schema in
 * decocms/stats-lake). Each organization reads it as its own user,
 * `org_<organization id>`. A row policy clamps that user to the org's rows and
 * a CONST read-only profile bounds every query, so raw SQL written by the org's
 * agent can never reach another org's data.
 *
 * Env vars (all needed; missing any = the lake is unavailable):
 *   CUSTOMER_LAKE_URL             – ClickHouse HTTPS URL
 *   CUSTOMER_LAKE_ADMIN_USERNAME  – may only create users (default "customer_lake_user_admin")
 *   CUSTOMER_LAKE_ADMIN_PASSWORD  – its password
 *   CUSTOMER_LAKE_TENANT_SECRET   – derives each org user's password, so nothing per org is stored
 */

import { createHmac } from "node:crypto";
import { getSettings } from "../settings";

type ClickHouseClient = import("@clickhouse/client").ClickHouseClient;

/**
 * Rows a query may return. The stats-lake profile sets the same max_result_rows,
 * but its `break` mode stops at a block boundary (up to ~65k rows), so the tool
 * trims to this.
 */
export const MAX_RESULT_ROWS = 1000;

/** The profile stops queries at 30 s; this only stops us waiting a bit longer. */
const REQUEST_TIMEOUT_MS = 40_000;

const ORG_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Org users this process already created; CREATE USER IF NOT EXISTS makes a repeat harmless. */
const ensuredUsers = new Set<string>();
/** In-flight `ensureTenantUser` calls, so concurrent queries for a cold org share one admin connection. */
const ensuringUsers = new Map<string, Promise<void>>();

export function isCustomerLakeConfigured(): boolean {
  const s = getSettings();
  return !!(
    s.customerLakeUrl &&
    s.customerLakeAdminPassword &&
    s.customerLakeTenantSecret
  );
}

/**
 * The org's ClickHouse user. The name goes into DDL and the row policy, so the
 * id is validated, never escaped. The `Lk1!` prefix satisfies ClickHouse Cloud's
 * password complexity rules; the HMAC is the secret part.
 */
export function tenantCredentials(
  organizationId: string,
  secret: string,
): { username: string; password: string } {
  if (!ORG_ID.test(organizationId)) {
    throw new Error("Invalid organization id for the data lake");
  }
  const mac = createHmac("sha256", secret).update(organizationId).digest("hex");
  return { username: `org_${organizationId}`, password: `Lk1!${mac}` };
}

/** One statement per request: drop trailing semicolons the agent tends to add. */
export function normalizeQuery(sql: string): string {
  return sql.trim().replace(/;+\s*$/, "");
}

async function connect(
  username: string,
  password: string,
): Promise<ClickHouseClient> {
  const { createClient } = await import("@clickhouse/client");
  return createClient({
    url: getSettings().customerLakeUrl,
    username,
    password,
    request_timeout: REQUEST_TIMEOUT_MS,
    // A readonly user may not set any per-query setting, compression included (164).
    compression: { request: false, response: false },
  });
}

async function ensureTenantUser(username: string, password: string) {
  if (ensuredUsers.has(username)) return;
  let promise = ensuringUsers.get(username);
  if (!promise) {
    promise = (async () => {
      const s = getSettings();
      const admin = await connect(
        s.customerLakeAdminUsername,
        s.customerLakeAdminPassword ?? "",
      );
      try {
        // Both values come from tenantCredentials: a validated id and hex.
        await admin.command({
          query: `CREATE USER IF NOT EXISTS \`${username}\` IDENTIFIED WITH sha256_password BY '${password}' SETTINGS PROFILE customer_lake_tenant_limits DEFAULT ROLE customer_lake_tenant`,
        });
        await admin.command({
          query: `GRANT customer_lake_tenant TO \`${username}\``,
        });
      } finally {
        await admin.close();
      }
      ensuredUsers.add(username);
    })();
    promise
      // Uncache on failure, so a bad attempt doesn't wedge every later query for the org.
      .catch(() => {})
      .finally(() => ensuringUsers.delete(username));
    ensuringUsers.set(username, promise);
  }
  return promise;
}

/** Run one read-only statement as the organization's own lake user.
 *  `queryParams` bind `{name:Type}` placeholders in `sql`. */
export async function queryCustomerLake(
  organizationId: string,
  sql: string,
  queryParams?: Record<string, unknown>,
): Promise<Record<string, unknown>[]> {
  const { username, password } = tenantCredentials(
    organizationId,
    getSettings().customerLakeTenantSecret ?? "",
  );
  await ensureTenantUser(username, password);
  const client = await connect(username, password);
  try {
    const result = await client.query({
      query: normalizeQuery(sql),
      query_params: queryParams,
      format: "JSONEachRow",
    });
    return await result.json<Record<string, unknown>>();
  } finally {
    await client.close();
  }
}
