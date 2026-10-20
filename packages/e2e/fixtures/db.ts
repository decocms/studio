/** Direct access to the same configured Postgres used by the API. */
import { Client } from "pg";

export async function connectDevDb(): Promise<Client> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "Set DATABASE_URL to the Postgres used by the API before running E2E tests.",
    );
  }
  const client = new Client({ connectionString });
  await client.connect();
  return client;
}
