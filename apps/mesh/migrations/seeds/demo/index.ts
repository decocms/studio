/**
 * Demo Seed
 *
 * Creates two complete demo environments:
 *
 * 1. **Onboarding** - Clean slate matching production behavior
 *    - 1 owner user
 *    - 3 well-known connections (Mesh MCP, MCP Registry, Deco Store)
 *    - 1 default gateway
 *    - No monitoring logs (start from scratch)
 *
 * 2. **Deco Bank** - Mature corporate banking environment
 *    - 12 users in realistic hierarchy
 *    - 10 real MCP connections (all verified)
 *    - 5 specialized gateways
 *    - ~2,500 logs over 90 days
 *
 * Demo Flow:
 * 1. Login as carlos.mendes@decobank.com (password: demo123)
 * 2. Start with "Onboarding" org -> show first steps
 * 3. Switch to "Deco Bank" org -> show mature usage
 */

import type { Kysely } from "kysely";
import type { Database } from "../../../src/storage/types";
import { createBetterAuthTables } from "../../../src/storage/test-helpers";

import type { OrgSeedResult } from "./seeder";
import { cleanupOrgs, createMemberRecord } from "./seeder";
import { seedOnboarding, ONBOARDING_SLUG } from "./orgs/onboarding";
import { seedDecoBank, DECO_BANK_SLUG } from "./orgs/deco-bank";

// =============================================================================
// Types
// =============================================================================

export interface DemoSeedResult {
  onboarding: OrgSeedResult;
  decoBank: OrgSeedResult;
}

// =============================================================================
// Main Seed Function
// =============================================================================

export async function seed(db: Kysely<Database>): Promise<DemoSeedResult> {
  // Create Better Auth tables (not created by Kysely migrations)
  await createBetterAuthTables(db);

  // Clean up any existing demo orgs (makes seed idempotent)
  await cleanupOrgs(db, [ONBOARDING_SLUG, DECO_BANK_SLUG]);

  // Create Onboarding organization
  console.log("🌱 Creating Onboarding organization...");
  const onboarding = await seedOnboarding(db);
  console.log(`   ✅ Onboarding: ${onboarding.logCount} logs`);

  // Create Deco Bank organization
  console.log("🏦 Creating Deco Bank organization...");
  const decoBank = await seedDecoBank(db);
  console.log(`   ✅ Deco Bank: ${decoBank.logCount} logs`);

  // Cross-org access: Add Deco Bank CTO as member of Onboarding
  console.log("🔗 Creating cross-org access...");
  const now = new Date().toISOString();

  await db
    .insertInto("member")
    .values(
      createMemberRecord(
        onboarding.organizationId,
        decoBank.userIds.cto!,
        "owner",
        now,
      ),
    )
    .execute();

  const ctoEmail = decoBank.userEmails.cto!;
  console.log(`   ✅ ${ctoEmail} now has access to both orgs`);

  // Display demo credentials
  console.log("\n📋 Demo Credentials:");
  console.log("   Password for all users: demo123\n");
  console.log("   🌟 RECOMMENDED FOR DEMO (access to both orgs):");
  console.log(`     - ${ctoEmail}`);
  console.log("");
  console.log("   Onboarding only:");
  console.log(`     - ${onboarding.userEmails.admin} (owner)`);
  console.log("   Deco Bank only:");
  console.log(`     - ${decoBank.userEmails.techLead} (admin)`);
  console.log(`     - ${decoBank.userEmails.seniorDev1} (member)`);
  console.log(`     - ... and more users`);

  return { onboarding, decoBank };
}

// Re-export types
export type { OrgSeedResult } from "./seeder";
