/**
 * Re-encrypt every vault-encrypted column from OLD_ENCRYPTION_KEY to
 * NEW_ENCRYPTION_KEY. The vault has no key-versioning, so rotating the key is
 * otherwise a hard break (see credential-vault.ts). Run this ONCE with the app
 * stopped, then swap ENCRYPTION_KEY and restart.
 *
 *   OLD_ENCRYPTION_KEY=... NEW_ENCRYPTION_KEY=... DATABASE_URL=... \
 *     bun run --cwd apps/api scripts/rotate-encryption-key.ts --dry-run
 *   ...same env... bun run ... scripts/rotate-encryption-key.ts --apply
 *
 * --dry-run (default): decrypt every cell with the OLD key to prove it all
 *   decodes; writes nothing. --apply: rewrite each cell with the NEW key.
 *
 * Idempotent: a cell that no longer decrypts with OLD but does with NEW is
 * treated as already-rotated and skipped, so a crashed --apply is resumable by
 * re-running it. Take a pg_dump first anyway.
 *
 * ponytail: per-cell autocommit, no wrapping transaction. Safe because the app
 * is down (mixed row state can't be observed) + the idempotent skip makes it
 * resumable. If you need strict all-or-nothing, wrap main() body in BEGIN/COMMIT.
 */
import pg from "pg";
import { CredentialVault } from "../src/encryption/credential-vault.ts";

const oldKey = process.env.OLD_ENCRYPTION_KEY;
const newKey = process.env.NEW_ENCRYPTION_KEY;
const dbUrl = process.env.DATABASE_URL;
const apply = process.argv.includes("--apply");

const oldVault = new CredentialVault(oldKey ?? "");
const newVault = new CredentialVault(newKey ?? "");

/**
 * Rotate one ciphertext cell. Returns the new ciphertext, or null if the value
 * is already rotated (decrypts with NEW, not OLD) and should be left as-is.
 * Throws if the value decrypts with neither key — a real corruption/wrong-key.
 */
async function rotateCell(ciphertext: string): Promise<string | null> {
  try {
    const plain = await oldVault.decrypt(ciphertext);
    return await newVault.encrypt(plain);
  } catch (oldErr) {
    try {
      await newVault.decrypt(ciphertext);
      return null; // already rotated
    } catch {
      throw oldErr; // decodes with neither key
    }
  }
}

/** connection_headers is a JSON string; for STDIO its envVars values are ciphertext. */
async function rotateConnectionHeaders(json: string): Promise<string | null> {
  const parsed = JSON.parse(json);
  const envVars = parsed?.envVars;
  if (!envVars || typeof envVars !== "object") return null; // nothing encrypted
  let changed = false;
  for (const [k, v] of Object.entries(envVars)) {
    if (typeof v !== "string") continue;
    const rotated = await rotateCell(v);
    if (rotated !== null) {
      envVars[k] = rotated;
      changed = true;
    }
  }
  return changed ? JSON.stringify({ ...parsed, envVars }) : null;
}

type Target = {
  table: string;
  pk: string;
  columns: string[];
  /** custom transform for JSON-wrapped columns; falls back to rotateCell */
  transform?: (col: string, value: string) => Promise<string | null>;
};

const TARGETS: Target[] = [
  {
    table: "connections",
    pk: "id",
    columns: ["connection_token", "configuration_state", "connection_headers"],
    transform: (col, value) =>
      col === "connection_headers"
        ? rotateConnectionHeaders(value)
        : rotateCell(value),
  },
  { table: "ai_provider_keys", pk: "id", columns: ["encrypted_api_key"] },
  { table: "secrets", pk: "id", columns: ["encrypted_value"] },
  {
    table: "downstream_tokens",
    pk: "id",
    columns: ["accessToken", "refreshToken", "clientSecret"],
  },
  { table: "org_sso_config", pk: "id", columns: ["client_secret"] },
  { table: "org_file_configs", pk: "id", columns: ["encrypted_credentials"] },
];

async function main() {
  if (process.argv.includes("--self-check")) return selfCheck();
  if (!oldKey || !newKey || !dbUrl) {
    throw new Error(
      "Set OLD_ENCRYPTION_KEY, NEW_ENCRYPTION_KEY, and DATABASE_URL.",
    );
  }
  console.log(
    apply ? "APPLY mode — will rewrite rows." : "DRY RUN — no writes.",
  );

  const client = new pg.Client(dbUrl);
  await client.connect();
  try {
    for (const t of TARGETS) {
      const quotedCols = t.columns.map((c) => `"${c}"`).join(", ");
      const { rows } = await client.query(
        `SELECT "${t.pk}", ${quotedCols} FROM "${t.table}"`,
      );
      let rotated = 0;
      let skipped = 0;
      for (const row of rows) {
        for (const col of t.columns) {
          const value = row[col];
          if (value == null || value === "") continue;
          const transform =
            t.transform ?? ((_c: string, v: string) => rotateCell(v));
          const next = await transform(col, value as string);
          if (next === null) {
            skipped++;
            continue;
          }
          rotated++;
          if (apply) {
            await client.query(
              `UPDATE "${t.table}" SET "${col}" = $1 WHERE "${t.pk}" = $2`,
              [next, row[t.pk]],
            );
          }
        }
      }
      console.log(
        `${t.table}: ${rows.length} rows, ${rotated} cells ${apply ? "rewritten" : "to rewrite"}, ${skipped} already-rotated/empty`,
      );
    }
  } finally {
    await client.end();
  }
  console.log(
    apply ? "Done. Now swap ENCRYPTION_KEY and restart." : "Dry run OK.",
  );
}

async function selfCheck() {
  const a = new CredentialVault("old-key-example");
  const b = new CredentialVault("new-key-example");
  const secret = "hunter2";
  const ct = await a.encrypt(secret);
  // rotate via the same predicate main() uses
  const rotate = async (c: string) => {
    try {
      return await b.encrypt(await a.decrypt(c));
    } catch {
      await b.decrypt(c);
      return null;
    }
  };
  const rotated = await rotate(ct);
  if (rotated === null) throw new Error("self-check: rotate returned null");
  if ((await b.decrypt(rotated)) !== secret) {
    throw new Error("self-check: new key cannot decrypt rotated value");
  }
  // re-running on already-rotated ciphertext must skip (return null)
  if ((await rotate(rotated)) !== null) {
    throw new Error("self-check: idempotent skip failed");
  }
  console.log("self-check OK");
}

await main();
