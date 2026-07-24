import { sql, type Kysely, type Transaction } from "kysely";
import { isAlreadyMemberError } from "./is-already-member-error";
import { isOrgArchived } from "@decocms/shared/organization/org-archived";
import { OrganizationDomainStorage } from "../storage/organization-domains";
import type { Database, OrganizationDomain } from "../storage/types";
import {
  defaultOrgNameForUser,
  domainDisplayName,
  domainToOrgSlug,
  emailDomainOf,
  isDiscoverableDomainRecord,
  isVerifiedCorporateUser,
} from "./org-assurance-policy";

const MAX_CREATE_ATTEMPTS = 5;

type DatabaseExecutor = Kysely<Database> | Transaction<Database>;

const ORG_NAME_TECH_SUFFIXES = [
  "labs",
  "agent",
  "studio",
  "workspace",
  "systems",
  "core",
  "cloud",
  "works",
];

const ORG_NAME_BR_SUFFIXES = [
  "capybara",
  "guarana",
  "deco",
  "samba",
  "feijoada",
  "capoeira",
  "carnival",
];

export interface AssuredUser {
  id: string;
  email: string;
  name?: string | null;
  emailVerified?: boolean;
}

export interface AuthOrganizationApi {
  createOrganization(input: {
    body: { name: string; slug: string; userId: string };
  }): Promise<unknown>;
  addMember(input: {
    body: { userId: string; role: string; organizationId: string };
  }): Promise<unknown>;
}

export interface EnsuredOrganization {
  id: string;
  name: string;
  slug: string;
  logo: string | null;
}

export interface DomainOrganizationCandidate extends EnsuredOrganization {
  joinMode: "auto" | "request";
}

export type EnsureOrganizationResult =
  | {
      status: "created";
      organization: EnsuredOrganization;
      domain: string | null;
      createdVia: string;
    }
  | {
      status: "already_has_organization";
      organization: EnsuredOrganization;
      domain: string | null;
    }
  | {
      status: "joined";
      organization: EnsuredOrganization;
      domain: string;
      createdVia: string;
    }
  | {
      status: "ambiguous";
      domain: string;
      organizations: DomainOrganizationCandidate[];
    }
  | {
      status: "skipped";
      reason:
        | "auto-create-disabled"
        | "no-safe-domain-action"
        | "pending-invitation";
      domain: string | null;
    };

export interface EnsureUserOrganizationOptions {
  db: Kysely<Database>;
  authApi: AuthOrganizationApi;
  user: AssuredUser;
  allowCreate: boolean;
  createdVia: string;
}

export async function ensureUserOrganization(
  options: EnsureUserOrganizationOptions,
): Promise<EnsureOrganizationResult> {
  const { db, authApi, user, allowCreate, createdVia } = options;
  const domain = emailDomainOf(user.email);

  return db.transaction().execute(async (trx) => {
    await sql`select pg_advisory_xact_lock(hashtext(${`user-org:${user.id}`})::bigint)`.execute(
      trx,
    );

    const existingOrganization = await getExistingUserOrganization(
      trx,
      user.id,
    );
    if (existingOrganization) {
      await repairMissingDomainClaimForExistingOrganization(
        trx,
        user,
        domain,
        existingOrganization,
      );

      return {
        status: "already_has_organization",
        organization: existingOrganization,
        domain,
      };
    }

    return ensureUserOrganizationInTransaction({
      db: trx,
      authApi,
      user,
      allowCreate,
      createdVia,
      domain,
    });
  });
}

async function ensureUserOrganizationInTransaction(options: {
  db: Transaction<Database>;
  authApi: AuthOrganizationApi;
  user: AssuredUser;
  allowCreate: boolean;
  createdVia: string;
  domain: string | null;
}): Promise<EnsureOrganizationResult> {
  const { db, authApi, user, allowCreate, createdVia, domain } = options;

  if (isVerifiedCorporateUser(user) && domain) {
    const domainStorage = new OrganizationDomainStorage(db);
    const domainRecords = await domainStorage.getAllByDomain(domain);
    const candidates = await getOrganizationsForDomainRecords(
      db,
      domainRecords,
    );

    if (candidates.length === 1 && candidates[0]?.joinMode === "auto") {
      const organization = candidates[0]!;
      // An explicit invitation to this org already governs membership. Skip the
      // domain auto-join so accepting the invitation is the single membership
      // path — otherwise the user gets a member row here AND a second one when
      // acceptInvitation unconditionally creates a member, showing up twice.
      if (await hasPendingInvitationToOrg(db, user.email, organization.id)) {
        return { status: "skipped", reason: "pending-invitation", domain };
      }
      await addMemberIdempotent(authApi, user.id, organization.id);

      return { status: "joined", organization, domain, createdVia };
    }

    if (candidates.length > 0) {
      return { status: "ambiguous", domain, organizations: candidates };
    }

    if (!allowCreate) {
      return { status: "skipped", reason: "auto-create-disabled", domain };
    }

    await sql`select pg_advisory_xact_lock(hashtext(${domain})::bigint)`.execute(
      db,
    );

    const lockedDomainStorage = new OrganizationDomainStorage(db);
    const lockedDomainRecords =
      await lockedDomainStorage.getAllByDomain(domain);
    const lockedCandidates = await getOrganizationsForDomainRecords(
      db,
      lockedDomainRecords,
    );

    if (
      lockedCandidates.length === 1 &&
      lockedCandidates[0]?.joinMode === "auto"
    ) {
      const organization = lockedCandidates[0]!;
      if (await hasPendingInvitationToOrg(db, user.email, organization.id)) {
        return { status: "skipped", reason: "pending-invitation", domain };
      }
      await addMemberIdempotent(authApi, user.id, organization.id);

      return { status: "joined", organization, domain, createdVia };
    }

    if (lockedCandidates.length > 0) {
      return {
        status: "ambiguous",
        domain,
        organizations: lockedCandidates,
      };
    }

    const created = await createOrganizationWithRetries(authApi, {
      name: domainDisplayName(domain),
      baseSlug: domainToOrgSlug(domain),
      userId: user.id,
    });

    await lockedDomainStorage.add(created.id, domain, {
      joinMode: "auto",
      verificationStatus: "verified",
      verificationMethod: "email",
    });

    const organization = await getOrganization(db, created.id);
    if (!organization) {
      throw new Error("Created organization could not be loaded");
    }

    return { status: "created", organization, domain, createdVia };
  }

  if (!allowCreate) {
    return { status: "skipped", reason: "auto-create-disabled", domain };
  }

  const orgName = `${defaultOrgNameForUser(user)} ${getRandomSuffix()}`;
  const created = await createOrganizationWithRetries(authApi, {
    name: orgName,
    baseSlug: slugify(orgName),
    userId: user.id,
  });
  const organization = await getOrganization(db, created.id);
  if (!organization) {
    throw new Error("Created organization could not be loaded");
  }

  return { status: "created", organization, domain, createdVia };
}

async function repairMissingDomainClaimForExistingOrganization(
  db: Transaction<Database>,
  user: AssuredUser,
  domain: string | null,
  organization: EnsuredOrganization,
): Promise<void> {
  if (!domain || !isVerifiedCorporateUser(user)) {
    return;
  }

  if (organization.slug !== domainToOrgSlug(domain)) {
    return;
  }

  const domainStorage = new OrganizationDomainStorage(db);
  const existingDomainRecords = await domainStorage.getAllByDomain(domain);
  if (existingDomainRecords.length > 0) {
    return;
  }

  // Repairs retries after org creation succeeded but adding the domain claim failed.
  await domainStorage.add(organization.id, domain, {
    joinMode: "auto",
    verificationStatus: "verified",
    verificationMethod: "email",
  });
}

async function getExistingUserOrganization(
  db: DatabaseExecutor,
  userId: string,
): Promise<EnsuredOrganization | null> {
  const existing = await db
    .selectFrom("member")
    .innerJoin("organization", "organization.id", "member.organizationId")
    .select([
      "organization.id as id",
      "organization.name as name",
      "organization.slug as slug",
      "organization.logo as logo",
      "organization.metadata as metadata",
    ])
    .where("member.userId", "=", userId)
    .orderBy("member.createdAt", "asc")
    .execute();

  const activeOrganization = existing.find(
    (organization) => !isOrgArchived(organization),
  );
  if (!activeOrganization) {
    return null;
  }

  const { metadata: _metadata, ...organization } = activeOrganization;
  return organization;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s_-]+/g, "")
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function getRandomSuffix(): string {
  const suffixes =
    Math.random() < 0.5 ? ORG_NAME_TECH_SUFFIXES : ORG_NAME_BR_SUFFIXES;
  return suffixes[Math.floor(Math.random() * suffixes.length)]!;
}

function asCreatedOrg(result: unknown): { id: string } {
  if (
    result &&
    typeof result === "object" &&
    "id" in result &&
    typeof result.id === "string"
  ) {
    return { id: result.id };
  }

  throw new Error("Failed to create organization");
}

function isOrganizationConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    "body" in error &&
    (error as { body?: { code?: string } }).body?.code ===
      "ORGANIZATION_ALREADY_EXISTS"
  );
}

async function getOrganization(
  db: DatabaseExecutor,
  organizationId: string,
): Promise<EnsuredOrganization | null> {
  return (
    (await db
      .selectFrom("organization")
      .select(["id", "name", "slug", "logo"])
      .where("id", "=", organizationId)
      .executeTakeFirst()) ?? null
  );
}

async function getOrganizationsForDomainRecords(
  db: DatabaseExecutor,
  records: OrganizationDomain[],
): Promise<DomainOrganizationCandidate[]> {
  const visibleRecords = records.filter(
    (record): record is OrganizationDomain & { joinMode: "auto" | "request" } =>
      isDiscoverableDomainRecord(record),
  );

  if (visibleRecords.length === 0) {
    return [];
  }

  const organizations = await db
    .selectFrom("organization")
    .select(["id", "name", "slug", "logo", "metadata"])
    .where(
      "id",
      "in",
      visibleRecords.map((record) => record.organizationId),
    )
    .execute();
  const organizationsById = new Map(
    organizations.map((organization) => [organization.id, organization]),
  );

  return visibleRecords.flatMap((record) => {
    const organization = organizationsById.get(record.organizationId);
    if (!organization) {
      return [];
    }
    if (isOrgArchived(organization)) {
      return [];
    }

    const { metadata: _metadata, ...activeOrganization } = organization;
    return [{ ...activeOrganization, joinMode: record.joinMode }];
  });
}

async function hasPendingInvitationToOrg(
  db: DatabaseExecutor,
  email: string,
  organizationId: string,
): Promise<boolean> {
  // The invitation table is managed by Better Auth and isn't in the Kysely
  // Database type, so query it with raw SQL (camelCase columns need quoting).
  const result = await sql<{ exists: boolean }>`
    select exists(
      select 1 from invitation
      where lower(email) = lower(${email})
        and "organizationId" = ${organizationId}
        and status = 'pending'
        and "expiresAt" > now()
    ) as exists
  `.execute(db);
  return result.rows[0]?.exists ?? false;
}

async function addMemberIdempotent(
  authApi: AuthOrganizationApi,
  userId: string,
  organizationId: string,
): Promise<void> {
  try {
    await authApi.addMember({
      body: { userId, role: "user", organizationId },
    });
  } catch (error) {
    if (!isAlreadyMemberError(error)) {
      throw error;
    }
  }
}

async function createOrganizationWithRetries(
  authApi: AuthOrganizationApi,
  input: { name: string; baseSlug: string; userId: string },
): Promise<{ id: string }> {
  for (let attempt = 0; attempt < MAX_CREATE_ATTEMPTS; attempt++) {
    const suffix =
      attempt === 0 ? "" : `-${Math.random().toString(36).slice(2, 6)}`;

    try {
      return asCreatedOrg(
        await authApi.createOrganization({
          body: {
            name: input.name,
            slug: `${input.baseSlug}${suffix}`,
            userId: input.userId,
          },
        }),
      );
    } catch (error) {
      if (
        !isOrganizationConflict(error) ||
        attempt === MAX_CREATE_ATTEMPTS - 1
      ) {
        throw error;
      }
    }
  }

  throw new Error("Failed to create organization");
}
