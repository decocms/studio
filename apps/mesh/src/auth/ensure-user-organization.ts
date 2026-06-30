import { sql, type Kysely, type Transaction } from "kysely";
import { OrganizationDomainStorage } from "../storage/organization-domains";
import type { Database, OrganizationDomain } from "../storage/types";
import {
  defaultOrgNameForUser,
  domainDisplayName,
  domainToOrgSlug,
  emailDomainOf,
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
      reason: "auto-create-disabled" | "no-safe-domain-action";
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
    const autoCandidates = candidates.filter(
      (candidate) => candidate.joinMode === "auto",
    );

    if (autoCandidates.length === 1) {
      const organization = autoCandidates[0]!;
      await addMemberIdempotent(authApi, user.id, organization.id);

      return { status: "joined", organization, domain, createdVia };
    }

    if (candidates.length > 0) {
      return { status: "ambiguous", domain, organizations: candidates };
    }

    if (domainRecords.length > 0) {
      return { status: "skipped", reason: "no-safe-domain-action", domain };
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
    const lockedAutoCandidates = lockedCandidates.filter(
      (candidate) => candidate.joinMode === "auto",
    );

    if (lockedAutoCandidates.length === 1) {
      const organization = lockedAutoCandidates[0]!;
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

    if (lockedDomainRecords.length > 0) {
      return { status: "skipped", reason: "no-safe-domain-action", domain };
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
    ])
    .where("member.userId", "=", userId)
    .executeTakeFirst();

  return existing ?? null;
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
      record.verificationStatus === "verified" && record.joinMode !== "off",
  );

  if (visibleRecords.length === 0) {
    return [];
  }

  const organizations = await db
    .selectFrom("organization")
    .select(["id", "name", "slug", "logo"])
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

    return [{ ...organization, joinMode: record.joinMode }];
  });
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
    const message = error instanceof Error ? error.message.toLowerCase() : "";
    if (!message.includes("already a member")) {
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
